import { beforeAll, describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { nextStep, successorOf } from "../../src/engine/next-step.ts";
import { loadPack } from "../../src/engine/pack-load.ts";
import type { Pack, Phase } from "../../src/engine/pack-types.ts";
import type { ChangeState, CheckResult } from "../../src/engine/state-types.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";

/** Fixture with Q1 answered: no open blocking question. */
const NO_QUESTION = FIXTURE_BODY.replace("- [ ] Q1 (blocking)", "- [x] Q1 (blocking)");
/** Every unit done. */
const ALL_DONE = NO_QUESTION.replace("- [ ] pending", "- [x] done");
/** U1 and U3 pending and waiting on each other. */
const NONE_READY = NO_QUESTION.replace("Depends: —", "Depends: U3").replace("- [x] done", "- [ ] pending");
/** No Branch and no Base: the change is not started. */
const NOT_STARTED = NO_QUESTION.replace(/^Base: .*\n/m, "").replace(/^Branch: .*\n/m, "");

const SPEC_ERROR: CheckResult = {
	check: "spec-format",
	code: "spec-no-requirements",
	severity: "error",
	file: "specs/rate-limit/spec.md",
	message: "Spec has no requirements",
};
const WARNING: CheckResult = { check: "spec-format", code: "spec-normative", severity: "warning", message: "needs SHALL" };

let pack: Pack;

beforeAll(async () => {
	const loaded = await loadPack("/nowhere", { readFile: async () => undefined });
	if (!loaded.ok) throw new Error("default pack must load");
	pack = loaded.pack;
});

function state(phase: string, body: string, overrides: Partial<ChangeState> = {}): ChangeState {
	return stateFor(phase, { change: parseChange(body), ...overrides });
}

function phaseOf(id: string, over: Partial<Phase> = {}): Phase {
	return { ...(pack.phases.find((p) => p.id === id) as Phase), ...over };
}

function blank(id: string, requires: string[]): Phase {
	return { id, requires, skills: { required: [], optional: [] }, outputs: [], redirects: [], checks: [], gate: "none", subagents: [] };
}

/** Default pack with `build` followed by `extra` phases in the given order (after build, before ship). */
function withBuildSuccessors(order: string[]): Pack {
	const before = pack.phases.filter((p) => ["shape", "define", "plan", "build"].includes(p.id));
	const after = pack.phases.filter((p) => ["ship", "close"].includes(p.id));
	const extra = order.map((id) => (id === "review" ? phaseOf("review") : blank(id, ["build"])));
	return { ...pack, phases: [...before, ...extra, ...after] };
}

describe("successorOf", () => {
	test("default pack order", () => {
		expect(successorOf(pack, "shape")).toBe("define");
		expect(successorOf(pack, "build")).toBe("review");
		expect(successorOf(pack, "close")).toBeUndefined();
	});
});

describe("nextStep", () => {
	test("Pure", () => {
		const input = state("build", NO_QUESTION);
		const frozen = structuredClone(input);
		const a = nextStep(pack, input);
		const b = nextStep(pack, input);
		expect(a).toEqual(b);
		expect(input).toEqual(frozen);
	});

	test("phase missing asks to repair labels", () => {
		const step = nextStep(pack, state("build", NO_QUESTION, { phase: { kind: "missing" } }));
		expect(step.next).toBe("Repair labels: the issue has no livespec:phase/* label.");
		expect(step.phase).toBeUndefined();
		expect(step.advance).toBeUndefined();
	});

	test("ambiguous phase asks to rerun the move", () => {
		const step = nextStep(pack, state("build", NO_QUESTION, { phase: { kind: "ambiguous", ids: ["define", "plan"] } }));
		expect(step.next).toBe("Repair labels: the issue has several phase labels (define, plan); rerun the phase move.");
		expect(step.phase).toBeUndefined();
	});

	test("phase not in the pack asks to repair labels", () => {
		const step = nextStep(pack, state("nowhere", NO_QUESTION));
		expect(step.next).toBe("Repair labels: phase nowhere is not in the flow pack.");
		expect(step.phase).toBeUndefined();
	});

	test("Not started", () => {
		const step = nextStep(pack, state("define", NOT_STARTED, { git: { branch: "main", head: "f".repeat(40), dirty: false, specsChanged: undefined } }));
		expect(step.next).toBe("Run change_start #7 to create the change branch.");
	});

	test("not started in shape follows the gate", () => {
		const step = nextStep(pack, state("shape", NOT_STARTED));
		expect(step.next).toBe("Checks pass; the shape gate can pass.");
	});

	test("Blocking question first", () => {
		const step = nextStep(pack, state("define", FIXTURE_BODY, { checks: [SPEC_ERROR] }));
		expect(step.next).toBe("Answer blocking question Q1 before continuing.");
		expect(step.blockingQuestions.map((q) => q.id)).toEqual(["Q1"]);
	});

	test("Missing output", () => {
		const sections = { Capabilities: true, Proposal: false, Design: true, Units: true };
		const step = nextStep(pack, state("define", NO_QUESTION, { sections }));
		expect(step.next).toBe("Write Proposal with spec_write.");
	});

	test("missing Capabilities comes first in output order", () => {
		const sections = { Capabilities: false, Proposal: false, Design: false, Units: false };
		expect(nextStep(pack, state("define", NO_QUESTION, { sections })).next).toBe("Write Capabilities with spec_write.");
	});

	test("missing Units names LS-05", () => {
		const sections = { Capabilities: true, Proposal: true, Design: true, Units: false };
		expect(nextStep(pack, state("plan", NO_QUESTION, { sections })).next).toBe(
			"Write Units (the plan_units tool arrives with LS-05).",
		);
	});

	test("specs-diff output missing in define", () => {
		const git = { branch: "livespec/per-ip-cap", head: "f".repeat(40), dirty: false, specsChanged: false };
		expect(nextStep(pack, state("define", NO_QUESTION, { git })).next).toBe("Edit specs/ for the declared capabilities.");
	});

	test("specs-diff output missing without checks", () => {
		const custom = { ...pack, phases: [...pack.phases, { ...blank("docs", ["close"]), outputs: ["specs-diff" as const] }] };
		const git = { branch: "livespec/per-ip-cap", head: "f".repeat(40), dirty: false, specsChanged: false };
		const step = nextStep(custom, state("docs", NO_QUESTION, { git }));
		expect(step.next).toBe("Edit specs/ for the declared capabilities.");
		expect(step.advance).toBeUndefined();
	});

	test("specs-diff output present", () => {
		const custom = { ...pack, phases: [...pack.phases, { ...blank("docs", ["close"]), outputs: ["specs-diff" as const] }] };
		const step = nextStep(custom, state("docs", NO_QUESTION));
		expect(step.next).toBe("The flow has no further phase.");
	});

	test("failing check names the check and its first result", () => {
		const step = nextStep(pack, state("define", NO_QUESTION, { checks: [WARNING, SPEC_ERROR] }));
		expect(step.next).toBe("Fix spec-format: Spec has no requirements.");
		expect(step.checks).toEqual([WARNING, SPEC_ERROR]);
	});

	test("failing custom check is named by its registered name", () => {
		const custom: CheckResult = { check: "depends-merged", code: "dep-open", severity: "error", message: "Change #34 is not merged." };
		const step = nextStep(pack, state("plan", NO_QUESTION, { checks: [custom] }));
		expect(step.next).toBe("Fix depends-merged: Change #34 is not merged.");
	});

	test("warnings alone do not block the gate", () => {
		expect(nextStep(pack, state("define", NO_QUESTION, { checks: [WARNING] })).next).toBe("Ready for the define gate.");
	});

	test("last phase with a human gate has no further phase", () => {
		const custom = { ...pack, phases: pack.phases.map((p) => (p.id === "close" ? { ...p, gate: "human" as const } : p)) };
		const step = nextStep(custom, state("close", ALL_DONE));
		expect(step.next).toBe("The flow has no further phase.");
		expect(step.advance).toBeUndefined();
	});

	test("last phase with a self gate has no further phase", () => {
		const custom = { ...pack, phases: pack.phases.map((p) => (p.id === "close" ? { ...p, gate: "self" as const } : p)) };
		const step = nextStep(custom, state("close", ALL_DONE));
		expect(step.next).toBe("The flow has no further phase.");
		expect(step.advance).toBeUndefined();
	});

	test("Next unit", () => {
		const step = nextStep(pack, state("build", NO_QUESTION));
		expect(step.next).toBe("Build U3 — Rate limit per IP.");
		expect(step.activeUnits).toEqual(["U3"]);
		expect(step.blockedUnits).toEqual([]);
	});

	test("Build with pending units does not advance", () => {
		const step = nextStep(pack, state("build", NO_QUESTION));
		expect(step.next).toBe("Build U3 — Rate limit per IP.");
		expect(step.advance).toBeUndefined();
	});

	test("No unit ready", () => {
		const step = nextStep(pack, state("build", NONE_READY));
		expect(step.next).toBe("No unit is ready: U1 waits on U3; U3 waits on U1.");
		expect(step.blockedUnits).toEqual([
			{ id: "U1", waitingOn: ["U3"] },
			{ id: "U3", waitingOn: ["U1"] },
		]);
		expect(step.activeUnits).toEqual([]);
		expect(step.advance).toBeUndefined();
	});

	test("Human gate ready", () => {
		const step = nextStep(pack, state("plan", NO_QUESTION));
		expect(step.next).toBe("Ready for the plan gate.");
		expect(step.advance).toBeUndefined();
	});

	test("self gate passes when checks pass", () => {
		const step = nextStep(pack, state("review", NO_QUESTION));
		expect(step.next).toBe("Checks pass; the review gate can pass.");
		expect(step.advance).toBeUndefined();
	});

	test("completed build moves to review", () => {
		const step = nextStep(pack, state("build", ALL_DONE));
		expect(step.next).toBe("Move to review.");
		expect(step.advance).toBe("review");
	});

	test("Last phase", () => {
		const step = nextStep(pack, state("close", ALL_DONE));
		expect(step.next).toBe("The flow has no further phase.");
		expect(step.advance).toBeUndefined();
	});

	test("Branching custom pack", () => {
		const custom = withBuildSuccessors(["review", "docs"]);
		expect(successorOf(custom, "build")).toBe("review");
		expect(nextStep(custom, state("build", ALL_DONE)).advance).toBe("review");
	});

	test("Custom successor", () => {
		const custom = withBuildSuccessors(["docs", "review"]);
		const step = nextStep(custom, state("build", ALL_DONE));
		expect(step.advance).toBe("docs");
		expect(step.next).toBe("Move to docs.");
	});

	test("Completed build with a human gate", () => {
		const custom = { ...pack, phases: pack.phases.map((p) => (p.id === "build" ? { ...p, gate: "human" as const } : p)) };
		const step = nextStep(custom, state("build", ALL_DONE));
		expect(step.next).toBe("Ready for the build gate.");
		expect(step.advance).toBeUndefined();
	});

	test("Counter shown with cap", () => {
		const step = nextStep(pack, state("review", NO_QUESTION, { counters: { review_rounds: 2, "unit_attempts.U3": 1, custom: 4 } }));
		expect(step.counters).toEqual([
			{ name: "custom", value: 4 },
			{ name: "review_rounds", value: 2, cap: 3 },
			{ name: "unit_attempts.U3", value: 1, cap: 3 },
		]);
	});

	test("reports the phase skills, redirects and incomplete markers", () => {
		const step = nextStep(pack, state("define", NO_QUESTION, { incomplete: ["U3"] }));
		expect(step.phase).toBe("define");
		expect(step.required).toEqual(["spec-driven-development"]);
		expect(step.optional).toEqual(["api-and-interface-design", "documentation-and-adrs", "deprecation-and-migration"]);
		expect(step.redirects).toHaveLength(2);
		expect(step.incomplete).toEqual(["U3"]);
	});
});
