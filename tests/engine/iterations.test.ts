import { describe, expect, test } from "vitest";
import { deriveIterations } from "../../src/engine/iterations.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";

let seq = 0;
function marked(kind: string, id: string, data: unknown): MarkedComment {
	seq += 1;
	return { commentId: `c${seq}`, kind, id, author: "bot", data };
}

const cascade = (q: string, afterPlan: boolean): MarkedComment =>
	marked("stale", q, { reason: q, phases: ["define", "plan"], units: [], after_plan: afterPlan });
const stuck = (id: string): MarkedComment =>
	marked("stuck", id, { where: "w", tried: [], hypothesis: "h", options: [{ id: "A", label: "a" }, { id: "B", label: "b" }], recommended: "A" });
const stuckAnswer = (id: string, outcome = "approved", choice = "A"): MarkedComment =>
	marked("stuck", `${id}-answer`, { request: `stuck-${id}.x`, outcome, choice, notes: "", by: "alice", at: "t", adapter: "forge" });

const fiveCascades = (): MarkedComment[] => ["Q1", "Q2", "Q3", "Q4", "Q5"].map((q) => cascade(q, true));

describe("deriveIterations", () => {
	test("Derived iteration count", () => {
		const state = deriveIterations([cascade("Q1", true), cascade("Q2", false), cascade("Q3", true), marked("counter", "change_iterations", { value: 9 })], 5);
		expect(state).toEqual({ count: 2, cap: 5, blocking: false, stuckOpen: undefined });
	});

	test("cap blocks without a later stuck answer", () => {
		const answeredBefore = [stuck("S1"), stuckAnswer("S1"), ...fiveCascades()];
		expect(deriveIterations(answeredBefore, 5)).toEqual({ count: 5, cap: 5, blocking: true, stuckOpen: undefined });
		expect(deriveIterations(fiveCascades()).blocking).toBe(false);
	});

	test("stuck answer after the last counted cascade lifts the block", () => {
		const state = deriveIterations([...fiveCascades(), cascade("Q6", false), stuck("S1"), stuckAnswer("S1")], 5);
		expect(state).toEqual({ count: 5, cap: 5, blocking: false, stuckOpen: undefined });
	});

	test("a new counted cascade blocks again", () => {
		const state = deriveIterations([...fiveCascades(), stuck("S1"), stuckAnswer("S1"), cascade("Q6", true)], 5);
		expect(state).toEqual({ count: 6, cap: 5, blocking: true, stuckOpen: undefined });
	});

	test("open stuck report is reported", () => {
		const state = deriveIterations([stuck("S1"), stuckAnswer("S1"), stuck("S2")], 5);
		expect(state).toEqual({ count: 0, cap: 5, blocking: false, stuckOpen: "S2" });
	});

	test("a dismissed stuck answer does not lift the cap", () => {
		const dismissed = deriveIterations([...fiveCascades(), stuck("S1"), stuckAnswer("S1", "dismissed", "")], 5);
		expect(dismissed).toEqual({ count: 5, cap: 5, blocking: true, stuckOpen: undefined });
		const noChoice = deriveIterations([...fiveCascades(), stuck("S1"), stuckAnswer("S1", "approved", "")], 5);
		expect(noChoice.blocking).toBe(true);
		const withNotes = deriveIterations([...fiveCascades(), stuck("S1"), stuckAnswer("S1", "approved_with_notes", "B")], 5);
		expect(withNotes.blocking).toBe(false);
	});
});
