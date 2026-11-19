// Tests of the finding, review and freshness checks of `unit_finish`, and of lanes for both unit tools.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { writeIn } from "../helpers/repo.ts";
import { seedSummary, warning } from "./finding-helpers.ts";
import { cleanupDirs, textOf } from "./helpers.ts";
import { buildPacket, changeName } from "../../src/subagents/packet.ts";
import { writePacket } from "../../src/subagents/packet-store.ts";
import { DEFAULT_SKILLS, makeTree } from "../subagents/packet-world.ts";
import { cardState, type UnitHarness, type UnitSpec, unitHarness } from "./unit-helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const SPEC = readFileSync(new URL("../fixtures/rate-limit.spec.md", import.meta.url), "utf8");
const SCRIPTS = { "specs/rate-limit/spec.md": SPEC, "check.sh": 'echo run >> "$LOG"\ntest -f src/u1.ts\n', "check2.sh": 'echo run >> "$LOG"\ntest -f src/u2.ts\n' };
const U1: UnitSpec = { id: "U1", verify: "sh check.sh" };
const U2: UnitSpec = { id: "U2", verify: "sh check2.sh" };
const MEDIUM: UnitSpec = { id: "U1", verify: "sh check.sh", difficulty: "medium" };
const REVIEW_WHEN_MEDIUM = "integrationBranch: main\n";

/** A started, committed and green U1. */
async function greenUnit(spec: UnitSpec = U1, units: UnitSpec[] = [spec]): Promise<UnitHarness> {
	const h = await unitHarness({ units, scripts: SCRIPTS, config: REVIEW_WHEN_MEDIUM });
	const out = await h.start("U1");
	if (out.isError) throw new Error(textOf(out));
	await h.commit({ "src/u1.ts": "x\n" });
	return h;
}

async function expectRefused(h: UnitHarness, parts: string[]): Promise<void> {
	const before = (await h.marked()).length;
	const out = await h.finish("U1");
	expect(out.isError, textOf(out)).toBe(true);
	for (const part of parts) expect(textOf(out)).toContain(part);
	expect(await h.marked()).toHaveLength(before);
	expect((await h.units())[0]?.done).toBe(false);
}

describe("review-findings at unit_finish", () => {
	test("unresolved blocking finding refuses finish", async () => {
		const h = await greenUnit();
		const id = await seedSummary(h, { findings: [warning()] });
		await expectRefused(h, ["a.ts:1", id, "finding_rebut"]);
	});

	test("a rebutted finding no longer refuses", async () => {
		const h = await greenUnit();
		const id = await seedSummary(h, { findings: [warning()] });
		await h.seed("finding-summary", `finding-summary.rebut.${id}`, { rebuts: id, items: [{ index: 0, reason: "r", evidence: "e" }] });
		const out = await h.finish("U1");
		expect(out.isError, textOf(out)).toBeFalsy();
	});

	test("advisory findings do not refuse", async () => {
		const h = await greenUnit();
		await seedSummary(h, { advisory: true, findings: [warning({ severity: "CRITICAL" })] });
		expect((await h.finish("U1")).isError).toBeFalsy();
	});

	test("review required but not run", async () => {
		const h = await greenUnit(MEDIUM);
		await expectRefused(h, ["unit review", "subagent_packet reviewer U1 unit"]);
	});

	test("a completed review at HEAD satisfies the requirement", async () => {
		const h = await greenUnit(MEDIUM);
		await seedSummary(h);
		expect((await h.finish("U1")).isError).toBeFalsy();
	});

	test("incomplete review does not count", async () => {
		const h = await greenUnit(MEDIUM);
		await seedSummary(h, { status: "NEEDS_CONTEXT", completed: false });
		await expectRefused(h, ["unit review"]);
	});

	test("a review of an older commit does not count", async () => {
		const h = await greenUnit(MEDIUM);
		await seedSummary(h, { head: "0".repeat(40) });
		await expectRefused(h, ["unit review"]);
	});

	test("a low unit needs no review", async () => {
		const h = await greenUnit();
		expect((await h.finish("U1")).isError).toBeFalsy();
	});

	test("lane review accepted after merge", async () => {
		const h = await greenUnit(MEDIUM);
		h.git("switch", "-q", "-c", "side", "HEAD~0");
		await writeIn(h.root, "side.txt", "s\n");
		h.git("add", "-A");
		h.git("commit", "-q", "-m", "side");
		const side = h.git("rev-parse", "HEAD");
		h.git("switch", "-q", "livespec/per-ip-cap");
		await writeIn(h.root, "main.txt", "m\n");
		h.git("add", "-A");
		h.git("commit", "-q", "-m", "main");
		h.git("merge", "--no-ff", "-q", "-m", "merge lane", side);
		await h.session.refresh();
		await seedSummary(h, { head: side });
		const out = await h.finish("U1");
		expect(out.isError, textOf(out)).toBeFalsy();
	});

	test("receipted unit with a new blocking finding", async () => {
		const h = await unitHarness({ units: [U1], scripts: SCRIPTS, update: (call) => (call === 1 ? "throw" : undefined) });
		await h.start("U1");
		await h.commit({ "src/u1.ts": "x\n" });
		await expect(h.finish("U1")).rejects.toThrow("transport failed");
		await seedSummary(h, { findings: [warning({ severity: "CRITICAL" })] });
		await expectRefused(h, ["a.ts:1"]);
		expect(await h.ofKind("receipt")).toHaveLength(1);
	});
});

describe("freshness at unit_finish", () => {
	async function dispatched(): Promise<UnitHarness> {
		const h = await greenUnit();
		h.session.activeTree = makeTree(DEFAULT_SKILLS);
		const ctx = { session: h.session, state: cardState(h).state, pack: h.session.pack.ok ? h.session.pack.pack : (undefined as never), forge: h.forge, git: h.session.git, root: h.root, cwd: h.root, budgetTokens: 24000 };
		const built = await buildPacket(ctx, "implementer", "U1");
		if (!built.ok) throw new Error(built.message);
		await writePacket(h.root, changeName(ctx), built.packet);
		await h.seed("dispatch", "dispatch.U1.implementer.1", {
			role: "implementer", unit: "U1", attempt: 1, packet: built.packet.hash, agentSource: "s", requested: { thinking: "low" }, effective: {},
			status: "DONE", commits: [], notes: "n", discoveries: [], sources_used: [],
		});
		return h;
	}

	test("a dispatched unit with no news ticks", async () => {
		const h = await dispatched();
		const out = await h.finish("U1");
		expect(out.isError, textOf(out)).toBeFalsy();
	});

	test("new human comment stops unit_finish", async () => {
		const h = await dispatched();
		const comment = await h.world.postComment(h.n, "alice", "actually use a token bucket");
		await h.session.comments?.invalidate(h.n);
		const out = await h.finish("U1");
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain(`comment:${comment}`);
		expect(await h.ofKind("receipt")).toHaveLength(0);
		expect((await h.ofKind("stuck")).length).toBeGreaterThan(0);
		expect((await h.units())[0]?.done).toBe(false);
	});

	test("an inline unit has no packet and skips freshness", async () => {
		const h = await greenUnit();
		await h.world.postComment(h.n, "alice", "late remark");
		await h.session.comments?.invalidate(h.n);
		expect((await h.finish("U1")).isError).toBeFalsy();
	});
});
