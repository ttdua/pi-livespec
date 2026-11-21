// Tests of the ship gate payload section and the aggregate follow-ups in the findings section.
import { beforeEach, describe, expect, test } from "vitest";
import { gatePayload } from "../../src/engine/gate-payload.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import { registerGate, resetGatesForTests } from "../../src/engine/gates.ts";
import { registerBuiltinChecks } from "../../src/engine/checks.ts";
import { registerReviewPayload } from "../../src/review/payload.ts";
import { subagentFindingsSection } from "../../src/subagents/payload.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";
import { reviewed } from "../subagents/helpers.ts";
import { agg, aggregate, mark, rebut, run, verifier } from "./review-fixtures.ts";

const H = "f".repeat(40);
const FACTS = { specsStat: "", specsFiles: [] };
const key = (m: { commentId: string }, i: number) => `${m.commentId}:${i}`;

async function ship(marked: ReturnType<typeof run>[]) {
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	return gatePayload(stateFor("ship", { marked }, FIXTURE_BODY), loaded.pack, "ship", FACTS);
}

beforeEach(() => {
	resetGatesForTests();
	registerGate("noop", { checks: [] });
	registerReviewPayload();
});

describe("ship payload", () => {
	test("registerBuiltinChecks re-registers the payload after a gate reset", async () => {
		resetGatesForTests();
		registerBuiltinChecks();
		const a = aggregate([agg({ route: "out-of-scope", routeUnit: undefined })], 1, H);
		expect((await ship([run({ head: H, routed: true }), a])).summary).toContain("Review round 1");
	});

	test("Disputed and inline at ship", async () => {
		const a = aggregate([agg({ evidence: "off by one" })], 2, H);
		const marked = [run({ round: 2, head: H, routed: true }), a, verifier(key(a, 0), { verdict: "refuted", reason: "guarded by caller" }), reviewed({ subject: "change", unit: undefined, head: H, agentSource: "inline" })];
		const { summary } = await ship(marked);
		expect(summary).toContain(`Review round 2 at ${H}`);
		expect(summary).toContain("Disputed:");
		expect(summary).toContain("guarded by caller");
		expect(summary).toContain("Inline reviews: change");
	});

	test("Rebutted aggregate finding", async () => {
		const a = aggregate([agg({ verify: "skipped-off" })], 1, H);
		const { summary } = await ship([run({ head: H, routed: true }), a, rebut(a.commentId, 0)]);
		expect(summary).toContain("Rebutted:");
	});

	test("Out of scope does not block: the follow-up is listed", async () => {
		const a = aggregate([agg({ route: "out-of-scope", routeUnit: undefined, verify: "skipped-off", location: "src/legacy.ts:1" })], 1, H);
		const { summary, findings } = await ship([run({ head: H, routed: true }), a]);
		expect(summary).toContain("Follow-up:");
		expect(summary).toContain("src/legacy.ts:1");
		expect(findings).toContain(key(a, 0));
	});

	test("no routed round adds nothing", async () => {
		expect((await ship([run({ head: H })])).summary).not.toContain("Review round");
	});

	test("a gate that showed the follow-up no longer lists it in the findings section", () => {
		const a = aggregate([agg({ route: "out-of-scope", routeUnit: undefined, verify: "skipped-off" })], 1, H);
		const marked = [run({ head: H, routed: true }), a];
		expect(subagentFindingsSection(marked).keys).toEqual([key(a, 0)]);
		const shown = mark(writeMarked("gate", "review.self-1", { phase: "review", findings: [key(a, 0)] }));
		expect(subagentFindingsSection([...marked, shown]).keys).toEqual([]);
	});

	test("a disputed out-of-scope finding is not a follow-up", () => {
		const a = aggregate([agg({ route: "out-of-scope", routeUnit: undefined })], 1, H);
		const marked = [run({ head: H, routed: true }), a, verifier(key(a, 0), { verdict: "refuted" })];
		expect(subagentFindingsSection(marked).keys).toEqual([]);
	});
});
