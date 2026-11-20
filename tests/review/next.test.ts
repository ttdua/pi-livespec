// Tests of the review phase's next steps (review-phase "Review next steps", "Review round cap", "Code simplification unit").
import { beforeAll, describe, expect, test } from "vitest";
import { nextStep } from "../../src/engine/next-step.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import type { ChangeState } from "../../src/engine/state-types.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";
import { reviewed } from "../subagents/helpers.ts";
import { agg, aggregate, run, stuckAnswer, stuckReport } from "./review-fixtures.ts";

let pack: Pack;
beforeAll(async () => {
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

const H = "f".repeat(40);
const OPEN = FIXTURE_BODY.replace("- [ ] Q1 (blocking)", "- [x] Q1 (blocking)");
const DONE = OPEN.replace("- [ ] pending", "- [x] done");
const at = (marked: MarkedComment[], over: Partial<ChangeState> = {}, body = DONE) => nextStep(pack, stateFor("review", { marked, ...over }, body));
const routed = (over = {}) => run({ head: H, routed: true, ...over });
const reviewer = (subject: "change" | `persona:${string}`, over: Record<string, unknown> = {}) => reviewed({ subject, unit: undefined, head: H, ...over });
const SIMPLIFY_NOTE = { skillNotes: ["review.code-simplification"] };

describe("Review round before the gate", () => {
	test("no round yet asks for spec_review, not the gate", () => {
		const step = at([]);
		expect(step.next).toContain("Run spec_review.");
		expect(step.next).toContain("start a round");
		expect(step.advance).toBeUndefined();
	});

	test("a round started and not routed asks for spec_review and names inline runs", () => {
		const step = at([run({ head: H, selected: ["change"] })]);
		expect(step.next).toContain("launch the missing reviewers");
		expect(step.next).toContain("subagent_packet reviewer change, then subagent_record reviewer change");
	});

	test("an unrouted round at HEAD never reaches the gate, even with a clean aggregate", () => {
		const step = at([run({ head: H }), aggregate([agg({ route: "record", verify: "skipped-suggestion", severity: "SUGGESTION" })], 1, H)]);
		expect(step.next).toContain("Run spec_review.");
	});

	test("a routed clean round at HEAD reaches the gate (idempotent second call)", () => {
		const marked = [routed(), aggregate([], 1, H)];
		expect(at(marked).next).toBe("Checks pass; the review gate can pass.");
	});

	test("a routed round at an older HEAD asks for spec_review", () => {
		expect(at([run({ head: "old", routed: true }), aggregate([], 1, "old")]).next).toContain("Run spec_review.");
	});
});

describe("review steps", () => {
	test("Back to build", () => {
		const step = at([routed(), aggregate([agg()], 1, H)], {}, OPEN);
		expect(step.next).toBe("Return to build to rebuild U3.");
		expect(step.advance).toBe("build");
	});

	test("Reviewer blocked", () => {
		const marked = [run({ head: H, selected: ["change", "persona:test-engineer"] }), reviewer("change"), reviewer("persona:test-engineer", { completed: false, status: "BLOCKED" })];
		const step = at(marked);
		expect(step.next).toContain("spec_stuck");
		expect(step.next).toContain("persona:test-engineer");
	});

	test("a stuck answer lifts the blocked reviewer", () => {
		const marked = [run({ head: H, selected: ["persona:test-engineer"] }), reviewer("persona:test-engineer", { completed: false, status: "BLOCKED" }), stuckReport("stuck-1"), stuckAnswer("stuck-1")];
		expect(at(marked).next).toContain("launch the missing reviewers");
	});

	test("In-change finding", () => {
		const finding = agg({ route: "in-change", routeUnit: undefined, verify: "skipped-off", location: "src/util/clock.ts:4" });
		const step = at([routed(), aggregate([finding], 1, H)]);
		expect(step.next).toContain("unit_amend --add");
		expect(step.next).toContain("src/util/clock.ts");
	});

	test("Cap reached: spec_stuck comes before the return to build", () => {
		const marked = [aggregate([], 1), aggregate([], 2), routed({ round: 3 }), aggregate([agg()], 3, H)];
		const step = at(marked, {}, OPEN);
		expect(step.next).toContain("spec_stuck");
		expect(step.advance).toBeUndefined();
	});

	test("Last round finishes before the cap", () => {
		const marked = [aggregate([], 1), aggregate([], 2), run({ round: 3, head: H }), aggregate([agg()], 3, H)];
		expect(at(marked).next).toContain("verify the findings");
	});

	test("Out of scope does not block", () => {
		const finding = agg({ route: "out-of-scope", routeUnit: undefined, verify: "skipped-off" });
		expect(at([routed(), aggregate([finding], 1, H)]).next).toBe("Checks pass; the review gate can pass.");
	});
});

describe("Simplify offered", () => {
	const clean = [routed(), aggregate([], 1, H)];

	test("offered before the gate once the skill note exists and the round is clean", () => {
		const step = at(clean, SIMPLIFY_NOTE);
		expect(step.next).toContain("unit_amend --add");
		expect(step.next).toContain("simplify");
		expect(step.next).toContain("Kind: refactor");
	});

	test("not offered without the skill note", () => {
		expect(at(clean).next).toBe("Checks pass; the review gate can pass.");
	});

	test("not offered while a finding blocks", () => {
		const marked = [routed(), aggregate([agg({ route: "in-change", routeUnit: undefined, verify: "skipped-off" })], 1, H)];
		expect(at(marked, SIMPLIFY_NOTE).next).not.toContain("simplify");
	});

	test("not offered when a simplify unit exists", () => {
		const body = DONE.replace("Add a unit", "Add a unit").replace(/^### U1 — .*$/m, "### U1 — Simplify");
		expect(at(clean, SIMPLIFY_NOTE, body).next).toBe("Checks pass; the review gate can pass.");
	});
});
