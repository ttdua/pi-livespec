// Tests of aggregate finding status, the review_rounds cap and the review-clean check.
import { beforeEach, describe, expect, it } from "vitest";
import { parseChange, type Question } from "../../src/core/change.ts";
import { getCheck, resetRegistryForTests } from "../../src/engine/registry.ts";
import { blockingFindings, findingState, registerReviewClean, reviewRounds } from "../../src/review/status.ts";
import { FIXTURE_BODY } from "../helpers/change-state.ts";
import { agg, aggregate, rebut, run, stuckAnswer, stuckReport, verifier } from "./review-fixtures.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";

const key = (m: MarkedComment, i: number) => `${m.commentId}:${i}`;
const question = (text: string, checked: boolean): Question => ({ id: "Q1", kind: "non-blocking", text, checked, line: 1 });

describe("findingState", () => {
	it("Refuted finding", () => {
		const a = aggregate([agg()]);
		expect(findingState([a, verifier(key(a, 0), { verdict: "refuted" })], a.commentId, 0, [])).toBe("disputed");
	});

	it("Confirmed finding", () => {
		const a = aggregate([agg(), agg({ location: "src/x.ts:1" })]);
		expect(findingState([a, verifier(key(a, 1))], a.commentId, 1, [])).toBe("blocking");
	});

	it("Verifier blocked", () => {
		const a = aggregate([agg()]);
		const blocked = verifier(key(a, 0), { status: "BLOCKED", completed: false, verdict: undefined });
		expect(findingState([a, blocked], a.commentId, 0, [])).toBe("blocking");
	});

	it("refuted, then incomplete run stays disputed", () => {
		const a = aggregate([agg()]);
		const refuted = verifier(key(a, 0), { verdict: "refuted" });
		const partial = verifier(key(a, 0), { round: 2, status: "DONE", completed: false, verdict: "confirmed" });
		expect(findingState([a, refuted, partial], a.commentId, 0, [])).toBe("disputed");
	});

	it("refuted, then a BLOCKED run counts as confirming", () => {
		const a = aggregate([agg()]);
		const refuted = verifier(key(a, 0), { verdict: "refuted" });
		const blocked = verifier(key(a, 0), { round: 2, status: "BLOCKED", completed: false, verdict: undefined });
		expect(findingState([a, refuted, blocked], a.commentId, 0, [])).toBe("blocking");
	});

	it("an incomplete, not blocked verifier run leaves the finding unverified", () => {
		const a = aggregate([agg()]);
		const partial = verifier(key(a, 0), { status: "DONE", completed: false, verdict: "refuted" });
		expect(findingState([a, partial], a.commentId, 0, [])).toBe("unverified");
	});

	it("Unverified finding blocks", () => {
		const a = aggregate([agg()]);
		expect(findingState([a], a.commentId, 0, [])).toBe("unverified");
		expect(blockingFindings([a], a.commentId, [])).toEqual([{ index: 0, finding: expect.objectContaining({ route: "unit" }) }]);
	});

	it("Answered question", () => {
		const a = aggregate([agg({ route: "question", routeUnit: undefined, verify: "skipped-off" })]);
		const text = `Decide finding:${key(a, 0)}`;
		expect(findingState([a], a.commentId, 0, [question(text, false)])).toBe("blocking");
		expect(findingState([a], a.commentId, 0, [question(text, true)])).toBe("answered");
		expect(blockingFindings([a], a.commentId, [question(text, true)])).toEqual([]);
	});

	it("out-of-scope and record never block", () => {
		const a = aggregate([agg({ route: "out-of-scope", routeUnit: undefined }), agg({ route: "record", severity: "SUGGESTION", verify: "skipped-suggestion" })]);
		expect(findingState([a], a.commentId, 0, [])).toBe("open");
		expect(findingState([a], a.commentId, 1, [])).toBe("open");
		expect(blockingFindings([a], a.commentId, [])).toEqual([]);
	});

	it("a rebutted WARNING does not block, a rebutted missed-context does", () => {
		const a = aggregate([agg({ verify: "skipped-off" }), agg({ kind: "missed-context", route: "in-change", verify: "skipped-missed-context" })]);
		const marked = [a, rebut(a.commentId, 0)];
		expect(findingState(marked, a.commentId, 0, [])).toBe("rebutted");
		expect(findingState([...marked, rebut(a.commentId, 1)], a.commentId, 1, [])).toBe("blocking");
	});

	it("a refuted verifier record of a parent or missed-context finding does not dispute it", () => {
		const a = aggregate([agg({ from: ["parent"], verify: "skipped-parent" }), agg({ kind: "missed-context", verify: "skipped-missed-context" })]);
		const marked = [a, verifier(key(a, 0), { verdict: "refuted" }), verifier(key(a, 1), { verdict: "refuted" })];
		expect(findingState(marked, a.commentId, 0, [])).toBe("blocking");
		expect(findingState(marked, a.commentId, 1, [])).toBe("blocking");
	});
});

/** One routed round whose aggregate holds `findings` (verified as confirmed). */
function round(n: number, findings = [agg({ verify: "skipped-off" })], routed = true): MarkedComment[] {
	return [run({ round: n, head: `h${n}` }), aggregate(findings, n, `h${n}`), ...(routed ? [run({ round: n, head: `h${n}`, routed: true })] : [])];
}

describe("reviewRounds", () => {
	it("Cap reached", () => {
		expect(reviewRounds([...round(1), ...round(2), ...round(3)], 3)).toEqual({ value: 3, blocking: true });
	});

	it("Last round finishes before the cap", () => {
		expect(reviewRounds([...round(1), ...round(2), ...round(3, undefined, false)], 3)).toEqual({ value: 3, blocking: false });
	});

	it("Stuck answer restarts the budget", () => {
		const capped = [...round(1), ...round(2), ...round(3)];
		expect(reviewRounds([...capped, stuckReport("S1"), stuckAnswer("S1", "approved", "A")], 3)).toEqual({ value: 0, blocking: false });
		expect(reviewRounds([...capped, stuckReport("S1"), stuckAnswer("S1", "approved", "A"), ...round(4)], 3)).toEqual({ value: 1, blocking: false });
	});

	it("a dismissed or choiceless answer does not lift the cap", () => {
		const capped = [...round(1), ...round(2), ...round(3)];
		expect(reviewRounds([...capped, stuckReport("S1"), stuckAnswer("S1", "dismissed")], 3).value).toBe(3);
		expect(reviewRounds([...capped, stuckReport("S1"), stuckAnswer("S1", "approved", "")], 3).value).toBe(3);
	});

	it("a stuck answer not sent while the cap blocked does not reset the count", () => {
		const marked = [...round(1), stuckReport("S1"), ...round(2), stuckAnswer("S1"), ...round(3)];
		expect(reviewRounds(marked, 3)).toEqual({ value: 3, blocking: true });
	});

	it("a round whose only blocker is a question finding does not block", () => {
		const q = [agg({ route: "question", routeUnit: undefined, verify: "skipped-off" })];
		expect(reviewRounds([...round(1), ...round(2), ...round(3, q)], 3)).toEqual({ value: 3, blocking: false });
	});

	it("an in-change blocker blocks; a clean round or no cap does not", () => {
		const inChange = [agg({ route: "in-change", routeUnit: undefined, verify: "skipped-off" })];
		expect(reviewRounds([...round(1), ...round(2), ...round(3, inChange)], 3).blocking).toBe(true);
		expect(reviewRounds([...round(1), ...round(2), ...round(3, [])], 3).blocking).toBe(false);
		expect(reviewRounds([...round(1), ...round(2), ...round(3)], undefined)).toEqual({ value: 3, blocking: false });
	});
});

describe("review-clean", () => {
	beforeEach(() => {
		resetRegistryForTests();
		registerReviewClean();
	});

	const check = async (marked: MarkedComment[], head: string) => {
		const fn = getCheck("review-clean");
		if (!fn) throw new Error("review-clean is not registered");
		return fn({ root: "/", change: parseChange(FIXTURE_BODY), marked, git: { diff: async () => "", head: async () => head, showFile: async () => undefined, listTree: async () => [] } });
	};

	it("Clean round passes the gate", async () => {
		const findings = [agg(), agg({ severity: "SUGGESTION", route: "record", routeUnit: undefined, verify: "skipped-suggestion" })];
		const marked = round(2, findings);
		const a = marked[1] as MarkedComment;
		expect(await check([...marked, verifier(key(a, 0), { verdict: "refuted" })], "h2")).toEqual([]);
	});

	it("Code changed after review", async () => {
		const results = await check(round(2, []), "d4");
		expect(results).toEqual([expect.objectContaining({ code: "review-clean", severity: "error", message: expect.stringContaining("d4") })]);
	});

	it("no review round fails, and a blocking finding is named", async () => {
		expect(await check([], "h1")).toEqual([expect.objectContaining({ code: "review-clean", severity: "error" })]);
		const results = await check(round(1), "h1");
		expect(results).toHaveLength(1);
		expect(results[0]?.message).toContain("src/limit.ts:10");
	});
});
