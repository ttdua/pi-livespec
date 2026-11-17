import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { unitDigest } from "../../src/core/digest.ts";
import { registerBuiltinRules } from "../../src/decide/registry.ts";
import { decisionComment } from "../../src/decide/records.ts";
import { registerBuiltinChecks } from "../../src/engine/checks.ts";
import { clearGateMemo, resetRegistryForTests } from "../../src/engine/registry.ts";
import { pollApprovals } from "../../src/interaction/poll.ts";
import { setRedOnBaseEnv } from "../../src/evidence/red-on-base.ts";
import { verifyEnv } from "../../src/evidence/verify-env.ts";
import { filterMarked, type MarkedComment } from "../../src/forge/markers.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import { BOT_LOGIN } from "../forge/world.ts";
import { cleanupDirs, textOf, type ToolHarness, toolHarness } from "../tools/helpers.ts";
import { changeBody, type UnitSpec, verifyDirs, worktreeCount } from "../tools/unit-helpers.ts";

const dirs: string[] = [];
const FORGE_CHAIN = "integrationBranch: main\ninteraction: { adapter: [forge] }\n";
const GATE = "plan";

type Gate = ToolHarness & { log: string; runs(): number };

/** A plan-phase change whose units run on `Base` (the first commit, which holds `files`). */
async function planChange(units: UnitSpec[], files: Record<string, string> = {}, withEnv = true): Promise<Gate> {
	const dir = mkdtempSync(join(tmpdir(), "ls-red-log-"));
	dirs.push(dir);
	const log = join(dir, "runs.log");
	const text = Object.fromEntries(Object.entries(files).map(([p, t]) => [p, t.replaceAll("$LOG", log)]));
	const h = await toolHarness({ config: FORGE_CHAIN, files: text, change: { body: changeBody(units.map((u) => ({ ...u, verify: u.verify.replaceAll("$LOG", log) }))), phase: "plan" } });
	setRedOnBaseEnv(withEnv ? () => verifyEnv(h.session) : async () => undefined);
	for (const u of parseChange(await h.world.bodyOf(h.n)).units) {
		const digest = unitDigest(u);
		await h.world.postComment(h.n, BOT_LOGIN, decisionComment({ point: "tags", subject: u.id, digest, source: "rule", outcome: u.tags, reason: "rule" }));
		await h.world.postComment(h.n, BOT_LOGIN, decisionComment({ point: "difficulty", subject: u.id, digest, source: "rule", outcome: u.difficulty, reason: "rule" }));
	}
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
	const runs = () => {
		try {
			return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
		} catch {
			return 0;
		}
	};
	return { ...h, log, runs };
}

async function requestOf(h: Gate): Promise<{ data: Record<string, any>; text: string }> {
	const marked = filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
	const request = marked.filter((m: MarkedComment) => m.kind === "request").at(-1);
	if (!request) throw new Error("no request");
	return { data: request.data as Record<string, any>, text: await h.world.commentBodyOf(request.commentId) };
}

const COUNT = "echo run >> $LOG; exit 1";

beforeEach(() => clearGateMemo());
afterEach(async () => {
	setRedOnBaseEnv(async () => undefined);
	setSession(undefined);
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	await cleanupDirs();
});

describe("verify-red-on-base", () => {
	test("Green on base refuses the plan gate", async () => {
		const h = await planChange([{ id: "U1", verify: COUNT }, { id: "U2", verify: "true" }]);
		const out = await h.call("spec_gate", { target: GATE });
		expect(out.isError, textOf(out)).toBe(false);
		const { data, text } = await requestOf(h);
		expect(data.snapshot.failingWaivable).toEqual(["verify-red-on-base"]);
		expect(data.options).toEqual([expect.objectContaining({ id: "waive" })]);
		expect(text).toContain("U2");
		expect(text).toContain("green");
		expect(worktreeCount(h)).toBe(1);
		expect([...verifyDirs()].filter((d) => d.startsWith("livespec-verify-"))).toEqual([]);
	});

	test("Pending unit exempt", async () => {
		const h = await planChange([{ id: "U1", verify: COUNT, files: ["tests/u1.test.ts"] }]);
		await h.call("spec_gate", { target: GATE });
		const { data, text } = await requestOf(h);
		expect(data.snapshot.failingWaivable).toEqual([]);
		expect(text).toContain("verifier pending");
		expect(h.runs()).toBe(0);
	});

	test("Refactor without a test", async () => {
		const missing = await planChange([{ id: "U2", verify: "true", kind: "refactor", files: ["tests/u2.test.ts"] }]);
		await missing.call("spec_gate", { target: GATE });
		const first = await requestOf(missing);
		expect(first.data.snapshot.failingWaivable).toEqual(["verify-red-on-base"]);
		expect(first.text).toContain("refactor needs an existing test");
		await cleanupDirs();
		clearGateMemo();
		const present = await planChange([{ id: "U2", verify: "true", kind: "refactor", files: ["tests/u2.test.ts"] }], { "tests/u2.test.ts": "x\n" });
		await present.call("spec_gate", { target: GATE });
		const second = await requestOf(present);
		expect(second.data.snapshot.failingWaivable).toEqual([]);
		expect(second.text).not.toContain("verify-red-on-base");
	});

	test("Missing toolchain is not red", async () => {
		const h = await planChange([{ id: "U1", verify: "nosuchtool-livespec test" }]);
		await h.call("spec_gate", { target: GATE });
		const { data, text } = await requestOf(h);
		expect(data.snapshot.failingWaivable).toEqual(["verify-red-on-base"]);
		expect(text).toContain("could not run");
	});

	test("Blocked Verify is never run", async () => {
		const h = await planChange([{ id: "U1", verify: "echo run >> $LOG && git push" }]);
		await h.call("spec_gate", { target: GATE });
		const { data, text } = await requestOf(h);
		expect(data.snapshot.failingWaivable).toEqual(["verify-red-on-base"]);
		expect(text).toContain("blocked");
		expect(h.runs()).toBe(0);
	});

	test("Memoized", async () => {
		const h = await planChange([{ id: "U1", verify: COUNT }, { id: "U2", verify: COUNT.replace("run", "run2") }]);
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(2);
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(2);
		// One unit changes: only it runs again.
		const body = (await h.world.bodyOf(h.n)).replace("Verify: `echo run2 >> ", "Verify: `echo run3 >> ");
		await h.world.editBodyBehindBack(h.n, body);
		await h.session.comments?.invalidate(h.n);
		await h.session.refresh();
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(3);
	});

	test("memo is scoped to the session", async () => {
		const h = await planChange([{ id: "U1", verify: COUNT }, { id: "U2", verify: COUNT.replace("run", "run2") }]);
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(2);
		clearGateMemo();
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(4);
	});

	test("missing environment cannot be approved without a waiver", async () => {
		const h = await planChange([{ id: "U1", verify: COUNT }], {}, false);
		const out = await h.call("spec_gate", { target: GATE });
		expect(out.isError, textOf(out)).toBe(false);
		const { data, text } = await requestOf(h);
		expect(data.snapshot.failingWaivable).toEqual(["verify-red-on-base"]);
		expect(data.options).toEqual([expect.objectContaining({ id: "waive" })]);
		expect(text).toContain("verify-red-on-base cannot run: no livespec session");
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec approve");
		await h.call("spec_status");
		expect(h.session.commandWarnings.join("\n")).toContain("choose waive");
		const marked = filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
		expect(marked.filter((m) => m.kind === "gate")).toEqual([]);
	});
});

describe("gate-only check at the gate", () => {
	test("Gate-only check runs at the gate", async () => {
		const h = await planChange([{ id: "U1", verify: COUNT }]);
		expect(h.runs()).toBe(0);
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(1);
		const { text } = await requestOf(h);
		expect(text).toContain("Units:");
		expect(h.session.card.kind).toBe("change");
	});

	test("Forge answer completed without rerunning gate-only checks", async () => {
		const h = await planChange([{ id: "U1", verify: COUNT }]);
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(1);
		// A new process: an empty registry and an empty memo, the check registered again.
		resetRegistryForTests();
		registerBuiltinRules();
		registerBuiltinChecks();
		setRedOnBaseEnv(() => verifyEnv(h.session));
		await h.world.setPermission("alice", "write");
		await h.world.postComment(h.n, "alice", "/livespec approve");
		await pollApprovals(h.session);
		const marked = filterMarked(await h.world.forge.listComments(h.n), BOT_LOGIN).comments;
		const gates = marked.filter((m) => m.kind === "gate");
		expect(gates).toHaveLength(1);
		expect(gates[0]?.data).toMatchObject({ phase: GATE, outcome: "approved" });
		expect(gates[0]?.data).not.toHaveProperty("superseded");
		expect(h.runs()).toBe(1);
	});
});

describe("memo of invalid runs", () => {
	test("a not-runnable Verify runs once across two gates", async () => {
		const h = await planChange([{ id: "U1", verify: "echo run >> $LOG; exit 127" }]);
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(1);
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(1);
		const { text } = await requestOf(h);
		expect(text).toContain("could not run");
	});

	test("an aborted run is retried", async () => {
		const h = await planChange([{ id: "U1", verify: COUNT }]);
		const aborted = new AbortController();
		aborted.abort();
		setRedOnBaseEnv(() => verifyEnv(h.session, aborted.signal));
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(0);
		setRedOnBaseEnv(() => verifyEnv(h.session));
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(1);
		// The result of the retry (red, so no error) is now memoized: a third gate does not run it again.
		await h.call("spec_gate", { target: GATE });
		expect(h.runs()).toBe(1);
	});
});
