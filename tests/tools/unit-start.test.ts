import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { createLedger } from "../../src/ledger/index.ts";
import { writeIn } from "../helpers/repo.ts";
import { branchPushes, cleanupDirs, textOf } from "./helpers.ts";
import { openLane } from "./lane-helpers.ts";
import { cardState, seedRebuild, type UnitSpec, unitHarness, waitFor } from "./unit-helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

/** Logs one line per run, then passes only when `src/<unit>.ts` exists. */
const check = (file: string) => `echo run >> "$LOG"\ntest -f ${file}\n`;
const SCRIPTS = { "check.sh": check("src/u1.ts"), "check2.sh": check("src/u2.ts"), "pass.sh": 'echo run >> "$LOG"\nexit 0\n' };
const U1: UnitSpec = { id: "U1", verify: "sh check.sh" };
const U2: UnitSpec = { id: "U2", verify: "sh check2.sh" };

/** A refusal: an error naming `parts` that posts no evidence comment. */
async function expectRefusal(h: Awaited<ReturnType<typeof unitHarness>>, unit: string, parts: string[]): Promise<string> {
	const before = (await h.ofKind("unit-start")).length;
	const out = await h.start(unit);
	expect(out.isError, textOf(out)).toBe(true);
	for (const part of parts) expect(textOf(out)).toContain(part);
	expect(await h.ofKind("unit-start")).toHaveLength(before);
	return textOf(out);
}

describe("unit-evidence", () => {
	test("Red at pre starts the unit", async () => {
		const h = await unitHarness({ units: [U1], scripts: SCRIPTS });
		const out = await h.start("U1");
		expect(out.isError, textOf(out)).toBeFalsy();
		const [start] = await h.ofKind("unit-start");
		expect(start?.id).toMatch(/^U1\./);
		expect(start?.data).toMatchObject({ unit: "U1", verify: "sh check.sh", pre: { sha: h.head, exit: 1, verdict: "red" } });
		expect(start?.source).toBe("ledger");
		expect(await h.inLedger("unit-start")).toHaveLength(1);
		expect(await h.commentsOf("unit-start")).toEqual([]);
		expect(h.runs()).toBe(1);
		expect(Object.keys(cardState(h).state.evidence.started)).toEqual(["U1"]);
	});

	test("Green at pre is refused", async () => {
		const h = await unitHarness({ units: [{ id: "U1", verify: "sh pass.sh" }], scripts: SCRIPTS });
		await expectRefusal(h, "U1", ["green", "exit 0", "regression pin", "drop", "unit_amend", "fix"]);
	});

	test("Refactor unit must pass at pre", async () => {
		const h = await unitHarness({ units: [{ id: "U2", verify: "sh check2.sh", kind: "refactor" }], scripts: SCRIPTS });
		await expectRefusal(h, "U2", ["red", "exit 1"]);
		await h.commit({ "src/u2.ts": "x\n" });
		const out = await h.start("U2");
		expect(out.isError, textOf(out)).toBeFalsy();
		const [start] = await h.ofKind("unit-start");
		expect(start?.data).toMatchObject({ unit: "U2", refactor: true, pre: { exit: 0, verdict: "green" } });
	});

	test("Dirty tree", async () => {
		const h = await unitHarness({ units: [U1], scripts: SCRIPTS });
		await writeIn(h.root, "src/u1.ts", "x\n");
		await expectRefusal(h, "U1", ["commit"]);
		expect(h.runs()).toBe(0);
	});

	test("Frozen unit", async () => {
		const h = await unitHarness({ units: [U1], scripts: SCRIPTS });
		await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace("- [a] works", "- [a] works on the web"));
		await h.session.refresh();
		await expectRefusal(h, "U1", ["frozen", "unit_amend"]);
		expect(h.runs()).toBe(0);
	});

	test("Unmet dependency", async () => {
		const h = await unitHarness({ units: [U1, U2, { id: "U3", verify: "sh check.sh", depends: ["U1"] }], scripts: SCRIPTS });
		await expectRefusal(h, "U3", ["U1"]);
	});

	test("One started unit at a time", async () => {
		const h = await unitHarness({ units: [U1, U2], scripts: SCRIPTS });
		expect((await h.start("U1")).isError).toBeFalsy();
		const text = await expectRefusal(h, "U2", ["U1"]);
		expect(text).toContain("unit_finish U1");
	});

	test("Started in a lane", async () => {
		const h = await unitHarness({ units: [U1, U2], scripts: SCRIPTS });
		expect((await h.start("U1")).isError).toBeFalsy();
		const lane = await openLane(h, "U2");
		await writeIn(lane.path, "notes.txt", "lane work\n");
		lane.git("add", "-A");
		lane.git("commit", "-q", "-m", "lane work");
		const out = await h.start("U2");
		expect(out.isError, textOf(out)).toBeFalsy();
		const record = (await h.ofKind("unit-start")).find((m) => m.id.startsWith("U2."));
		expect(record?.data).toMatchObject({ unit: "U2", pre: { sha: lane.git("rev-parse", "HEAD"), exit: 1 } });
	});

	test("an open lane whose worktree is gone refuses naming the path", async () => {
		const h = await unitHarness({ units: [U1, U2], scripts: SCRIPTS });
		const lane = await openLane(h, "U2");
		rmSync(lane.path, { recursive: true, force: true });
		await expectRefusal(h, "U2", [lane.path, "lane_merge U2"]);
	});

	test("a dirty lane refuses, whatever the change worktree looks like", async () => {
		const h = await unitHarness({ units: [U1, U2], scripts: SCRIPTS });
		const lane = await openLane(h, "U2");
		await writeIn(lane.path, "scratch.txt", "x\n");
		await expectRefusal(h, "U2", ["dirty"]);
	});

	test("two units in different lanes may both be started", async () => {
		const h = await unitHarness({ units: [U1, U2], scripts: SCRIPTS });
		await openLane(h, "U1");
		await openLane(h, "U2");
		expect((await h.start("U1")).isError).toBeFalsy();
		// U1 runs in its own lane, so U2's lane is free; the change worktree has no started unit either.
		expect((await h.start("U2")).isError, "a second lane starts").toBeFalsy();
	});

	test("Restart after an amendment", async () => {
		const h = await unitHarness({ units: [U1], scripts: { ...SCRIPTS, "check-b.sh": check("src/u1.ts") } });
		expect((await h.start("U1")).isError).toBeFalsy();
		await expectRefusal(h, "U1", ["already started"]);
		// An approved amendment that changes U1's Verify: new body, then the amendment record with the new digest.
		const body = (await h.world.bodyOf(h.n)).replace("Verify: `sh check.sh`", "Verify: `sh check-b.sh`");
		await h.world.editBodyBehindBack(h.n, body);
		const digest = unitDigest(parseChange(body).units[0]!);
		await h.seed("amendment", "amend-1", { action: "edit", unit: "U1", new: digest, outcome: "approved" });
		const out = await h.start("U1");
		expect(out.isError, textOf(out)).toBeFalsy();
		const starts = await h.ofKind("unit-start");
		expect(starts).toHaveLength(2);
		expect(starts[1]?.data).toMatchObject({ verify: "sh check-b.sh", digest });
		expect(await h.inLedger("unit-start")).toHaveLength(2);
		expect(await h.commentsOf("unit-start")).toEqual([]);
	});

	test("Command not found is not red", async () => {
		const h = await unitHarness({ units: [{ id: "U1", verify: "nosuchtool test" }] });
		await expectRefusal(h, "U1", ["could not run", "127"]);
	});

	describe("Blocked Verify is never run", () => {
		test.each([
			["a normal unit", { id: "U1", verify: 'echo run >> "$LOG" && git push' }],
			["a pending unit", { id: "U1", verify: 'echo run >> "$LOG" && git push', files: ["src/u1.ts", "test/limit.test.ts"] }],
		])("%s", async (_name, unit) => {
			const h = await unitHarness({ units: [{ ...unit, verify: unit.verify }], scripts: SCRIPTS });
			// `$LOG` in the Verify text is never expanded: nothing runs at all.
			await expectRefusal(h, "U1", ["unit_amend", "livespec guard"]);
			expect(h.runs()).toBe(0);
			expect(await h.marked()).toHaveLength(1); // only the plan gate
		});
	});

	test("Pending start", async () => {
		const h = await unitHarness({ units: [{ id: "U1", verify: "sh check.sh", files: ["src/u1.ts", "test/limit.test.ts"] }], scripts: SCRIPTS });
		const out = await h.start("U1");
		expect(out.isError, textOf(out)).toBeFalsy();
		const [start] = await h.ofKind("unit-start");
		expect(start?.data).toMatchObject({ unit: "U1", pending: true, pre: { sha: h.head } });
		expect((start?.data as { pre: Record<string, unknown> }).pre.exit).toBeUndefined();
		expect(await h.commentsOf("unit-start")).toEqual([]);
		expect(await h.inLedger("unit-start")).toHaveLength(1);
		expect(h.runs()).toBe(0);
		expect(cardState(h).step.pendingVerifier).toEqual(["U1"]);
	});

	test("refactor unit cannot be verifier pending", async () => {
		const h = await unitHarness({ units: [{ id: "U1", verify: "sh check.sh", files: ["test/limit.test.ts"], kind: "refactor" }], scripts: SCRIPTS });
		await expectRefusal(h, "U1", ["a refactor needs an existing test"]);
		expect(h.runs()).toBe(0);
	});

	test("Token redacted everywhere: unit-start comment and result", async () => {
		const h = await unitHarness({ units: [{ id: "U1", verify: "sh leak.sh" }], scripts: { "leak.sh": "echo token=s3cr3t\nexit 1\n" } });
		h.session.redactionTokens = () => ["s3cr3t"];
		const out = await h.start("U1");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(textOf(out)).not.toContain("s3cr3t");
		const [start] = await h.ofKind("unit-start");
		expect(JSON.stringify(start?.data)).not.toContain("s3cr3t");
		expect(await h.commentsOf("unit-start")).toEqual([]);
		expect((start?.data as { pre: { output: string } }).pre.output).toContain("token=***");
	});

	test("session already shut down: unit_start refuses without spawning", async () => {
		const h = await unitHarness({ units: [U1], scripts: SCRIPTS });
		h.session.abortEvidence();
		await expectRefusal(h, "U1", ["aborted"]);
		expect(h.runs()).toBe(0);
	});

	test("extra parameters are ignored", async () => {
		const h = await unitHarness({ units: [U1], scripts: SCRIPTS });
		const out = await h.call("unit_start", { unit: "U1", exit: 0, verdict: "green", pending: true });
		expect(out.isError, textOf(out)).toBeFalsy();
		const [start] = await h.ofKind("unit-start");
		expect(start?.data).toMatchObject({ pre: { exit: 1, verdict: "red" } });
		expect((start?.data as { pending?: true }).pending).toBeUndefined();
	});

	test("the tool takes only a unit id", async () => {
		const h = await unitHarness({ units: [U1], scripts: SCRIPTS });
		for (const name of ["unit_start", "unit_finish"]) {
			expect(h.pi.tools.get(name)?.parameters).toEqual({ type: "object", properties: { unit: { type: "string" } }, required: ["unit"] });
		}
	});

	test("No push", async () => {
		const h = await unitHarness({ units: [U1], scripts: SCRIPTS });
		await h.start("U1");
		await h.settle();
		expect(branchPushes(h.gitCalls)).toEqual([]);
	});
});

describe("fix round 1", () => {
	test("I3: unit_start aborted while deciding pending writes nothing", async () => {
		const h = await unitHarness({ units: [{ id: "U1", verify: "sh check.sh", files: ["src/u1.ts", "test/limit.test.ts"] }], scripts: SCRIPTS });
		const pathExistsAt = h.session.git.pathExistsAt.bind(h.session.git);
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		let entered = false;
		h.session.git.pathExistsAt = async (sha, path) => {
			entered = true;
			await held;
			return pathExistsAt(sha, path);
		};
		const controller = new AbortController();
		const call = h.start("U1", controller.signal);
		await waitFor(() => entered);
		controller.abort();
		release();
		const out = await call;
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("aborted");
		expect(await h.ofKind("unit-start")).toHaveLength(0);
	});
});

describe("rebuild marker", () => {
	test("Rebuild starts green", async () => {
		const h = await unitHarness({ units: [U1, { id: "U2", verify: "sh pass.sh" }], scripts: SCRIPTS });
		await seedRebuild(h, "U2");
		expect(cardState(h).state.evidence.untickedReceipts).toEqual([]);
		const out = await h.start("U2");
		expect(out.isError, textOf(out)).toBeFalsy();
		const [start] = await h.ofKind("unit-start");
		expect(start?.data).toMatchObject({ unit: "U2", pre: { exit: 0, verdict: "rebuild" } });
		expect(cardState(h).state.evidence.rebuilds ?? {}).toEqual({});
	});

	test("A rebuild with a red Verify starts red", async () => {
		const h = await unitHarness({ units: [U1], scripts: SCRIPTS });
		await seedRebuild(h, "U1");
		const out = await h.start("U1");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect((await h.ofKind("unit-start"))[0]?.data).toMatchObject({ pre: { exit: 1, verdict: "red" } });
	});
});

/** Makes this clone a fresh one: no local ledger, no tracking ref, and a ledger object that has fetched nothing. */
function forgetLedger(h: Awaited<ReturnType<typeof unitHarness>>): void {
	for (const ref of [`refs/livespec/${h.n}`, `refs/livespec-origin/${h.n}`]) h.git("update-ref", "-d", ref);
	(h.session as { ledger: unknown }).ledger = createLedger(h.session.exec, h.root);
}

describe("unit-evidence on a second machine", () => {
	const twoUnits = [U1, { ...U2, depends: ["U1"] }];

	/** A receipt for U1 that exists only on origin (the body tick of U1 is already there). */
	async function receiptOnOriginOnly(h: Awaited<ReturnType<typeof unitHarness>>): Promise<void> {
		const u1 = (await h.units())[0]!;
		const sha = "a".repeat(40);
		await h.seed("unit-start", "U1.s", { unit: "U1", digest: unitDigest(u1), verify: u1.verify, pre: { sha, exit: 1, verdict: "red" } });
		await h.seed("receipt", "U1.r", { unit: "U1", digest: unitDigest(u1), verify: u1.verify, pre: { sha, exit: 1 }, post: { sha, exit: 0 }, output: "", start: "U1.s" });
		await h.world.editBodyBehindBack(h.n, (await h.world.bodyOf(h.n)).replace("- [ ] pending", "- [x] done"));
		expect(await h.session.ledger.sync(h.n)).toEqual({ status: "synced" });
	}

	test("a receipt that exists only on origin lets U2 start on a fresh clone", async () => {
		const h = await unitHarness({ units: twoUnits, scripts: SCRIPTS });
		await receiptOnOriginOnly(h);
		forgetLedger(h);
		const out = await h.start("U2");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect((await h.marked()).filter((m) => m.kind === "receipt").map((m) => m.id)).toEqual(["U1.r"]);
		expect((await h.inLedger("unit-start")).map((m) => (m.data as { unit: string }).unit)).toEqual(["U1", "U2"]);
		expect(await h.commentsOf("unit-start")).toEqual([]);
	});

	test("a start that exists only on origin makes U2 refuse on a fresh clone", async () => {
		const h = await unitHarness({ units: twoUnits.map((u) => ({ ...u, depends: [] })), scripts: SCRIPTS });
		expect((await h.start("U1")).isError).toBeFalsy();
		expect(await h.session.ledger.sync(h.n)).toEqual({ status: "synced" });
		forgetLedger(h);
		const out = await h.start("U2");
		expect(out.isError, textOf(out)).toBe(true);
		for (const part of ["U1 is started", "unit_finish U1", "one unit at a time"]) expect(textOf(out)).toContain(part);
		expect((await h.inLedger("unit-start")).map((m) => (m.data as { unit: string }).unit)).toEqual(["U1"]);
	});

	test("Unknown ledger while offline: unit_start refuses, runs no Verify and writes nothing", async () => {
		const h = await unitHarness({ units: twoUnits, scripts: SCRIPTS });
		await receiptOnOriginOnly(h);
		forgetLedger(h);
		h.git("remote", "set-url", "origin", join(tmpdir(), "ls-missing-origin", String(process.pid)));
		const comments = (await h.world.forge.listComments(h.n)).length;
		const out = await h.start("U2");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(`the ledger of #${h.n} could not be fetched; reconnect and retry`);
		expect(h.runs()).toBe(0);
		expect((await h.world.forge.listComments(h.n)).length).toBe(comments);
		expect((await h.session.ledger.read(h.n)).entries).toEqual([]);
	});
});
