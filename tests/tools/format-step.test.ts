import { describe, expect, test } from "vitest";
import type { NextStep } from "../../src/engine/state-types.ts";
import { formatStep } from "../../src/tools/format-step.ts";
import { stateFor } from "../helpers/change-state.ts";

const STEP: NextStep = {
	phase: "build",
	required: [],
	optional: [],
	redirects: [],
	checks: [],
	blockingQuestions: [],
	counters: [],
	activeUnits: [],
	blockedUnits: [],
	incomplete: [],
	pending: [{ id: "gate-plan.lx3k2a", subject: "gate:plan", mode: "blocking", adapter: "forge" }],
	frozenUnits: ["U2"],
	staleUnits: ["U3"],
	stuckOpen: "S1",
	next: "Wait for the human's choice on stuck report S1.",
};

describe("formatStep", () => {
	test("next-step text lists pending approvals, frozen and stale units and the stuck report", () => {
		const text = formatStep(STEP, stateFor("build"));
		expect(text).toContain("Pending approvals:\n- gate:plan (gate-plan.lx3k2a) via forge, blocking");
		expect(text).toContain("Frozen units: U2");
		expect(text).toContain("Stale units: U3");
		expect(text).toContain("Stuck report: S1");
	});

	test("next-step text omits empty approval lines", () => {
		const text = formatStep({ ...STEP, pending: [], frozenUnits: [], staleUnits: [], stuckOpen: undefined }, stateFor("build"));
		expect(text).not.toMatch(/Pending approvals|Frozen units|Stale units|Stuck report/);
	});
});
