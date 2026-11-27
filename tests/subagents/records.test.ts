// Tests of the dispatch and finding-summary records and the queries over them.
import { describe, expect, it } from "vitest";
import { type MarkedComment, parseMarked, writeMarked } from "../../src/forge/markers.ts";
import {
	aggregateFinding,
	changeReviewDoneAt,
	completedReviewAt,
	completedUnitRounds,
	reviewStepDoneAt,
	computeCompleted,
	dispatchComment,
	type FindingSummaryData,
	findingKey,
	findingSummaryComment,
	invalidRecords,
	latestDispatch,
	pendingQuestion,
	rebuttalComment,
	unresolvedBlocking,
	unshownSystemFindings,
} from "../../src/subagents/records.ts";
import { isSummaryData } from "../../src/subagents/validate.ts";
import { nextRound } from "../../src/subagents/run-record.ts";
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

	it("a system summary is no review, no round, and no later review resolves it", () => {
		const v = summary({ system: "files-violation", completed: true, findings: [finding({ scope: "out-of-scope", kind: "files-violation" })] });
		expect(completedReviewAt([v], "U1", ["h1"])).toBe(false);
		expect(reviewStepDoneAt([v], "U1", ["h1"], false)).toBe(false);
		expect(completedUnitRounds([v], "U1")).toBe(0);
		expect(nextRound([v], "reviewer", "U1", "unit")).toBe(1);
		const later = summary({ round: 2, findings: [] });
		expect(unresolvedBlocking([v, later], "U1", new Set(), new Set())).toEqual([]);
		expect(unresolvedBlocking([v], "U1", new Set(), new Set())).toEqual([]);
	});

	it("a malformed system field is invalid and never treated as a system summary", () => {
		for (const bad of [false, true, "other", 1, null]) {
			const m = summary({ system: bad as never, findings: [finding({ severity: "CRITICAL" })] });
			expect(invalidRecords([m])).toHaveLength(1);
			expect(unresolvedBlocking([m], "U1", new Set(), new Set())).toEqual([]);
		}
		const ok = summary({ findings: [finding({ severity: "CRITICAL" })] });
		expect(unresolvedBlocking([ok], "U1", new Set(), new Set())).toHaveLength(1);
	});

	it("a system summary has its own marker identity, so a later review does not supersede it", () => {
		const v = summary({ system: "files-violation", round: 1, findings: [finding({ scope: "out-of-scope", kind: "files-violation" })] });
		const review = summary({ round: 1 });
		expect(v.id).not.toBe(review.id);
		expect(unshownSystemFindings([v, review], new Set())).toHaveLength(1);
	});

	it("computeCompleted needs status and every required source", () => {
		expect(computeCompleted({ status: "DONE", sources_used: ["a", "b"] }, ["a"])).toBe(true);
		expect(computeCompleted({ status: "DONE", sources_used: [] }, ["a"])).toBe(false);
		expect(computeCompleted({ status: "BLOCKED", sources_used: ["a"] }, ["a"])).toBe(false);
	});
});

describe("verifier and aggregate records", () => {
	const aggregateFindings = [{ ...finding({ location: "src/u1.ts:1", severity: "CRITICAL" }), from: ["c9"], needsDecision: false, route: "unit" as const, routeUnit: "U1", verify: "required" as const }];
	const aggregate = (over: Partial<FindingSummaryData> = {}) =>
		mark(writeMarked("finding-summary", "finding-summary.change.review.1", {
			role: "reviewer", subject: "change", round: 1, status: "DONE", advisory: false, head: "h1", packet: "p", sources_used: [], required: [], completed: true,
			agentSource: "s", requested: { thinking: "low" }, effective: {}, findings: aggregateFindings, aggregate: true, reviews: ["c9"], ...over,
		}));
	const verifier = (over: Partial<FindingSummaryData> = {}) =>
		mark(findingSummaryComment({
			role: "verifier", subject: "change", round: 1, status: "DONE", advisory: false, head: "h1", packet: "p", sources_used: [], required: [], completed: true,
			agentSource: "s", requested: { thinking: "low" }, effective: {}, findings: [finding({ location: "src/u1.ts:1", severity: "CRITICAL" })],
			verifies: "c1:0", verdict: "refuted", reason: "guarded by caller", ...over,
		}));

	it("a verifier record has the verify id and valid data", () => {
		const v = verifier();
		expect(v.id).toBe("finding-summary.verify.c1-0.1");
		expect(invalidRecords([v])).toEqual([]);
		expect(invalidRecords([verifier({ verdict: "maybe" as never })])).toHaveLength(1);
	});

	it("unitFindings readers ignore verifier and aggregate records", () => {
		const v = verifier({ unit: "U1" });
		const a = aggregate({ unit: "U1" });
		expect(unresolvedBlocking([v, a], "U1", new Set(), new Set())).toEqual([]);
		expect(completedUnitRounds([v, a], "U1")).toBe(0);
	});

	it("an aggregate alone is no completed change review and uses no round", () => {
		const a = aggregate();
		expect(changeReviewDoneAt([a], "change", "h1")).toBe(false);
		expect(nextRound([a], "reviewer", undefined, "change")).toBe(1);
		const review = summary({ subject: "change", unit: undefined as never });
		expect(changeReviewDoneAt([a, review], "change", "h1")).toBe(true);
	});

	it("aggregateFinding finds the aggregate by comment id and index", () => {
		const a = aggregate();
		expect(aggregateFinding([a], `${a.commentId}:0`)).toMatchObject({ commentId: a.commentId, index: 0, finding: { location: "src/u1.ts:1", route: "unit" } });
		expect(aggregateFinding([a], `${a.commentId}:1`)).toBeUndefined();
		expect(aggregateFinding([a], "nope:0")).toBeUndefined();
		expect(aggregateFinding([a], "garbage")).toBeUndefined();
		const plain = summary({ findings: [finding()] });
		expect(aggregateFinding([plain], `${plain.commentId}:0`)).toBeUndefined();
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

describe("fix round 1", () => {
	const sameId = (m: MarkedComment, over: Partial<MarkedComment>): MarkedComment => ({ ...m, commentId: `c${++counter}`, ...over });

	it("superseded summary neither satisfies a review nor resolves a finding", () => {
		const good = summary({ head: "h1" });
		const redo = sameId(good, { data: { ...(good.data as object), completed: false, status: "BLOCKED" } });
		expect(completedReviewAt([good, redo], "U1", ["h1"])).toBe(false);
		const r1 = summary({ findings: [finding()] });
		const r2 = summary({ round: 2 });
		const r2again = sameId(r2, { data: { ...(r2.data as object), completed: false } });
		expect(unresolvedBlocking([r1, r2, r2again], "U1", new Set(), new Set())).toHaveLength(1);
	});

	it("advisory summary does not satisfy completedReviewAt", () => {
		expect(completedReviewAt([summary({ advisory: true, head: "h1" })], "U1", ["h1"])).toBe(false);
	});

	it("advisory round does not resolve findings of a non-advisory review", () => {
		const r1 = summary({ findings: [finding()] });
		const adv = summary({ round: 2, advisory: true });
		expect(unresolvedBlocking([r1, adv], "U1", new Set(), new Set())).toHaveLength(1);
	});

	it("invalid records are skipped, not thrown", () => {
		const bad = (kind: string, id: string, data: unknown): MarkedComment => ({ commentId: `c${++counter}`, kind, id, author: "me", data });
		const junk = [
			bad("dispatch", "d1", null),
			bad("dispatch", "d2", { status: "QUESTION", agentId: "a" }),
			bad("dispatch", "d3", { status: "QUESTION", role: "implementer", question: "q" }),
			bad("finding-summary", "f1", null),
			bad("finding-summary", "f2", { unit: "U1", findings: [{ severity: "WARNING" }], completed: true }),
		];
		expect(pendingQuestion(junk)).toBeUndefined();
		expect(latestDispatch(junk, "U1")).toBeUndefined();
		expect(unresolvedBlocking(junk, "U1", new Set(), new Set())).toEqual([]);
		expect(completedReviewAt(junk, "U1", ["h"])).toBe(false);
		expect(invalidRecords(junk)).toHaveLength(5);
	});
});

describe("fix round 2", () => {
	const raw = (kind: string, id: string, data: unknown): MarkedComment => ({ commentId: `c${++counter}`, kind, id, author: "me", data });
	const goodDispatch = { role: "implementer", unit: "U1", attempt: 1, status: "DONE", commits: [], notes: "n", discoveries: [], sources_used: [] };

	it.each([
		["bogus status", { ...goodDispatch, status: "bogus" }],
		["bogus role", { ...goodDispatch, role: "boss" }],
		["attempt not a number", { ...goodDispatch, attempt: "1" }],
		["sources_used not strings", { ...goodDispatch, sources_used: [1] }],
		["commits not strings", { ...goodDispatch, commits: "a" }],
		["discoveries missing", { ...goodDispatch, discoveries: undefined }],
		["ANSWERED without answer", { role: "implementer", status: "ANSWERED", agentId: "a" }],
	])("dispatch with %s is skipped and warned", (_l, data) => {
		const m = raw("dispatch", "d", data);
		expect(latestDispatch([m], "U1")).toBeUndefined();
		expect(invalidRecords([m])).toHaveLength(1);
	});

	it("a malformed summary does not resolve a blocker", () => {
		const r1 = summary({ findings: [finding()] });
		const bad = raw("finding-summary", "finding-summary.U1.unit.2", { ...(summary({ round: 2 }).data as object), findings: [{ ...finding(), severity: "bogus" }] });
		const badFlag = raw("finding-summary", "finding-summary.U1.unit.3", { ...(summary({ round: 3 }).data as object), advisory: "no" });
		expect(unresolvedBlocking([r1, bad, badFlag], "U1", new Set(), new Set())).toHaveLength(1);
		expect(invalidRecords([bad, badFlag])).toHaveLength(2);
	});

	it.each([
		["status", { status: "bogus" }],
		["round", { round: "2" }],
		["completed", { completed: "yes" }],
		["required", { required: [3] }],
		["kind enum", { findings: [{ ...finding(), kind: "x" }] }],
		["scope enum", { findings: [{ ...finding(), scope: "x" }] }],
	])("summary with bad %s is invalid", (_l, over) => {
		expect(invalidRecords([raw("finding-summary", "f", { ...(summary().data as object), ...over })])).toHaveLength(1);
	});
});

describe("fix round 3", () => {
	const raw = (kind: string, id: string, data: unknown): MarkedComment => ({ commentId: `c${++counter}`, kind, id, author: "me", data });
	const full = {
		role: "implementer", unit: "U1", attempt: 1, packet: "p", agentSource: "s", requested: { thinking: "low" }, effective: { model: "m", thinking: "high" },
		status: "DONE", commits: [], notes: "n", discoveries: [], sources_used: [],
	};

	it("a complete dispatch is valid", () => {
		expect(invalidRecords([raw("dispatch", "d", full)])).toEqual([]);
	});

	it.each(["commits", "notes", "packet", "agentSource", "requested", "effective"])("dispatch missing %s is invalid", (key) => {
		expect(invalidRecords([raw("dispatch", "d", { ...full, [key]: undefined })])).toHaveLength(1);
	});

	it.each([
		["requested.thinking", { requested: { thinking: "max" } }],
		["effective.model", { effective: { model: 3 } }],
		["agentId", { agentId: 4 }],
		["subject", { subject: "bogus" }],
	])("dispatch with wrong-typed %s is invalid", (_l, over) => {
		expect(invalidRecords([raw("dispatch", "d", { ...full, ...over })])).toHaveLength(1);
	});

	it("QUESTION with a non-numeric attempt is invalid", () => {
		const q = { status: "QUESTION", role: "implementer", agentId: "a", question: "q", attempt: "1" };
		expect(invalidRecords([raw("dispatch", "d", q)])).toHaveLength(1);
	});

	it.each(["bogus", "persona:", "persona"])("summary with subject %s is invalid", (subject) => {
		expect(invalidRecords([raw("finding-summary", "f", { ...(summary().data as object), subject })])).toHaveLength(1);
	});

	it.each(["spec", "plan", "unit", "change", "persona:security"])("summary with subject %s is valid", (subject) => {
		expect(invalidRecords([raw("finding-summary", "f", { ...(summary().data as object), subject })])).toEqual([]);
	});
});

describe("finding summary why fields", () => {
	const summary = { role: "reviewer", subject: "unit", round: 1, status: "DONE", advisory: false, head: "h", packet: "p", sources_used: [], required: [], completed: true, agentSource: "s", requested: { thinking: "low" }, effective: {}, findings: [] };
	it("older summary still valid", () => {
		expect(isSummaryData(summary)).toBe(true);
		expect(isSummaryData({ ...summary, notes: "n", reason: "r", evidence: "e" })).toBe(true);
		expect(isSummaryData({ ...summary, notes: 1 })).toBe(false);
		expect(isSummaryData({ ...summary, evidence: 1 })).toBe(false);
	});
});
