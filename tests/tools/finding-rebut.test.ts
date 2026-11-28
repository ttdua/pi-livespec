// Tests of `finding_rebut`: a rebuttal needs a blocking, rebuttable finding, a reason and evidence.
import { afterEach, describe, expect, test } from "vitest";
import { setSession } from "../../src/hooks/session-store.ts";
import { registerFindingRebut } from "../../src/tools/finding-rebut.ts";
import { unresolvedBlocking } from "../../src/subagents/records.ts";
import { cleanupDirs, textOf } from "./helpers.ts";
import { type UnitSpec, unitHarness } from "./unit-helpers.ts";
import { seedSummary, warning } from "./finding-helpers.ts";

afterEach(async () => {
	setSession(undefined);
	await cleanupDirs();
});

const U1: UnitSpec = { id: "U1", verify: "sh check.sh" };
const SCRIPTS = { "check.sh": 'echo run >> "$LOG"\ntest -f src/u1.ts\n' };

async function harness() {
	const h = await unitHarness({ units: [U1], scripts: SCRIPTS });
	registerFindingRebut(h.pi.api as never);
	const rebut = (params: Record<string, unknown>) => h.call("finding_rebut", params);
	return { h, rebut };
}

const unresolved = async (h: Awaited<ReturnType<typeof harness>>["h"]) => unresolvedBlocking(await h.marked(), "U1", new Set(), new Set());

describe("review-findings", () => {
	test("rebutted warning", async () => {
		const { h, rebut } = await harness();
		const id = await seedSummary(h, { findings: [warning()] });
		const out = await rebut({ comment: id, index: 0, reason: "the cap is per design", evidence: "design.md D3" });
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(await unresolved(h)).toEqual([]);
		const [posted] = (await h.ofKind("finding-summary")).slice(-1);
		expect(posted?.data).toMatchObject({ rebuts: id, items: [{ index: 0, reason: "the cap is per design", evidence: "design.md D3" }] });
		expect(posted?.source).toBe("ledger");
		expect(await h.commentsOf("finding-summary")).toEqual([]);
	});

	test("a second rebuttal keeps the first", async () => {
		const { h, rebut } = await harness();
		const id = await seedSummary(h, { findings: [warning(), warning({ location: "b.ts:2" })] });
		await rebut({ comment: id, index: 0, reason: "r1", evidence: "e1" });
		await rebut({ comment: id, index: 1, reason: "r2", evidence: "e2" });
		expect(await unresolved(h)).toEqual([]);
	});

	test("two parallel rebuttals of one summary both land", async () => {
		const { h, rebut } = await harness();
		const id = await seedSummary(h, { findings: [warning(), warning({ location: "b.ts:2" })] });
		const outs = await Promise.all([rebut({ comment: id, index: 0, reason: "r1", evidence: "e1" }), rebut({ comment: id, index: 1, reason: "r2", evidence: "e2" })]);
		for (const out of outs) expect(out.isError, textOf(out)).toBeFalsy();
		expect(await unresolved(h)).toEqual([]);
	});

	test("rebut missed-context refused", async () => {
		const { h, rebut } = await harness();
		const id = await seedSummary(h, { findings: [warning({ kind: "missed-context" })] });
		const before = (await h.marked()).length;
		const out = await rebut({ comment: id, index: 0, reason: "r", evidence: "e" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("missed-context");
		expect(await h.marked()).toHaveLength(before);
	});

	test.each([
		["reason", { reason: " ", evidence: "e" }],
		["evidence", { reason: "r", evidence: "" }],
	])("rebut without %s refused", async (_name, text) => {
		const { h, rebut } = await harness();
		const id = await seedSummary(h, { findings: [warning()] });
		const before = (await h.marked()).length;
		const out = await rebut({ comment: id, index: 0, ...text });
		expect(out.isError).toBe(true);
		expect(await h.marked()).toHaveLength(before);
	});

	test.each([
		["an unknown comment", () => "nope", 0],
		["an index out of range", (id: string) => id, 5],
	])("%s is refused", async (_name, pick, index) => {
		const { h, rebut } = await harness();
		const id = await seedSummary(h, { findings: [warning()] });
		const before = (await h.marked()).length;
		const out = await rebut({ comment: pick(id), index, reason: "r", evidence: "e" });
		expect(out.isError).toBe(true);
		expect(await h.marked()).toHaveLength(before);
	});

	test("a finding of an advisory summary is refused", async () => {
		const { h, rebut } = await harness();
		const id = await seedSummary(h, { advisory: true, findings: [warning()] });
		const before = (await h.marked()).length;
		const out = await rebut({ comment: id, index: 0, reason: "r", evidence: "e" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("advisory");
		expect(await h.marked()).toHaveLength(before);
	});

	test("a finding that does not block is refused", async () => {
		const { h, rebut } = await harness();
		const id = await seedSummary(h, { findings: [warning({ severity: "SUGGESTION" })] });
		const out = await rebut({ comment: id, index: 0, reason: "r", evidence: "e" });
		expect(out.isError).toBe(true);
		expect(textOf(out)).toContain("not blocking");
	});
});
