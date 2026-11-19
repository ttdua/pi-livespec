import { describe, expect, it } from "vitest";
import { type MarkedComment, parseMarked } from "../../src/forge/markers.ts";
import {
	completedReviewAt,
	computeCompleted,
	dispatchComment,
	type FindingSummaryData,
	findingKey,
	findingSummaryComment,
	latestDispatch,
	pendingQuestion,
	rebuttalComment,
	unresolvedBlocking,
} from "../../src/subagents/records.ts";
import type { Finding } from "../../src/subagents/roles.ts";

let counter = 0;
function mark(body: string): MarkedComment {
	const p = parseMarked(body);
	if (!p) throw new Error("not marked");
	return { commentId: `c${++counter}`, kind: p.kind, id: p.id, author: "me", data: p.data };
}

const finding = (over: Partial<Finding> = {}): Finding => ({
	severity: "WARNING", kind: "defect", location: "a.ts:1", evidence: "e", fix: "f", scope: "unit", ...over,
});

function summary(over: Partial<FindingSummaryData> = {}): MarkedComment {
	return mark(findingSummaryComment({
		role: "reviewer", subject: "unit", unit: "U1", round: 1, status: "DONE", advisory: false, head: "h1", packet: "p",
		sources_used: [], required: [], completed: true, agentSource: "s", requested: { thinking: "low" }, effective: {},
		findings: [], ...over,
	}));
}

describe("records", () => {
	it("dispatch marker kind registered", () => {
		const body = dispatchComment({
			role: "implementer", unit: "U1", attempt: 1, packet: "p", agentSource: "s", requested: { thinking: "low" }, effective: {},
			status: "DONE", commits: ["a"], notes: "n", discoveries: ["d"], sources_used: [],
		});
		expect(parseMarked(body)?.kind).toBe("dispatch");
		expect(latestDispatch([mark(body)], "U1")?.discoveries).toEqual(["d"]);
	});

	it("blocked round resolves nothing", () => {
		const r1 = summary({ findings: [finding()] });
		const r2 = summary({ round: 2, status: "BLOCKED", completed: false });
		expect(unresolvedBlocking([r1, r2], "U1", new Set(), new Set())).toHaveLength(1);
	});

	it("later completed round resolves findings it no longer reports", () => {
		const r1 = summary({ findings: [finding()] });
		const r2 = summary({ round: 2 });
		expect(unresolvedBlocking([r1, r2], "U1", new Set(), new Set())).toEqual([]);
	});

	it("advisory unit review not blocking", () => {
		const r = summary({ advisory: true, findings: [finding({ severity: "CRITICAL" })] });
		expect(unresolvedBlocking([r], "U1", new Set(), new Set())).toEqual([]);
	});

	it("rebutted warning resolved", () => {
		const r = summary({ findings: [finding()] });
		const rebut = mark(rebuttalComment({ rebuts: r.commentId, items: [{ index: 0, reason: "r", evidence: "e" }] }));
		expect(unresolvedBlocking([r, rebut], "U1", new Set(), new Set())).toEqual([]);
	});

	it("missed-context not resolvable by rebuttal", () => {
		const r = summary({ findings: [finding({ kind: "missed-context", severity: "SUGGESTION" })] });
		const rebut = mark(rebuttalComment({ rebuts: r.commentId, items: [{ index: 0, reason: "r", evidence: "e" }] }));
		expect(unresolvedBlocking([r, rebut], "U1", new Set(), new Set())).toHaveLength(1);
	});

	it("needs-decision resolved after answer, out-of-scope after a gate", () => {
		const r = summary({ findings: [finding({ scope: "needs-decision" }), finding({ scope: "out-of-scope", location: "b.ts:2" })] });
		expect(unresolvedBlocking([r], "U1", new Set(), new Set())).toHaveLength(2);
		const left = unresolvedBlocking([r], "U1", new Set([findingKey(r.commentId, 0)]), new Set([findingKey(r.commentId, 1)]));
		expect(left).toEqual([]);
	});

	it("lane head accepted as second parent", () => {
		const r = summary({ head: "lane1" });
		expect(completedReviewAt([r], "U1", ["merge", "lane1"])).toBe(true);
		expect(completedReviewAt([r], "U1", ["merge"])).toBe(false);
	});

	it("incomplete review does not count", () => {
		const r = summary({ status: "NEEDS_CONTEXT", completed: false, head: "h1" });
		expect(completedReviewAt([r], "U1", ["h1"])).toBe(false);
	});

	it("computeCompleted needs status and every required source", () => {
		expect(computeCompleted({ status: "DONE", sources_used: ["a", "b"] }, ["a"])).toBe(true);
		expect(computeCompleted({ status: "DONE", sources_used: [] }, ["a"])).toBe(false);
		expect(computeCompleted({ status: "BLOCKED", sources_used: ["a"] }, ["a"])).toBe(false);
	});
});

describe("pendingQuestion", () => {
	const question = () => mark(dispatchComment({ status: "QUESTION", role: "implementer", unit: "U1", agentId: "a1", question: "Which file?" }));
	const answered = () => mark(dispatchComment({ status: "ANSWERED", role: "implementer", unit: "U1", agentId: "a1", answer: "x" }));

	it("pending question survives a reload", () => {
		expect(pendingQuestion([question()])).toEqual({ unit: "U1", role: "implementer", agentId: "a1", question: "Which file?" });
	});

	it("an ANSWERED record closes it", () => {
		expect(pendingQuestion([question(), answered()])).toBeUndefined();
	});

	it("answered question of a reviewer is closed", () => {
		const q = mark(dispatchComment({ status: "QUESTION", role: "reviewer", unit: "U1", agentId: "r1", question: "?" }));
		const a = mark(dispatchComment({ status: "ANSWERED", role: "reviewer", unit: "U1", agentId: "r1", answer: "!" }));
		expect(pendingQuestion([q])?.agentId).toBe("r1");
		expect(pendingQuestion([q, a])).toBeUndefined();
		expect(pendingQuestion([q, a, summary({ agentId: "r1" })])).toBeUndefined();
		expect(pendingQuestion([q, summary({ agentId: "r1" })])).toBeUndefined();
	});
});
