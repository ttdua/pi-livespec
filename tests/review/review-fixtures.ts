// Shared builders of review marked comments for the review tests.
import { type MarkedComment, parseMarked, writeMarked } from "../../src/forge/markers.ts";
import { aggregateComment, reviewRunComment, type ReviewRunData } from "../../src/review/records.ts";
import { type AggregateFinding, type FindingSummaryData, findingSummaryComment, rebuttalComment } from "../../src/subagents/records.ts";
import type { Finding } from "../../src/subagents/roles.ts";

let counter = 0;
export function mark(body: string): MarkedComment {
	const p = parseMarked(body);
	if (!p) throw new Error("not marked");
	return { source: "forge", ref: `c${++counter}`, kind: p.kind, id: p.id, author: "me", data: p.data };
}

export const finding = (over: Partial<Finding> = {}): Finding => ({
	severity: "WARNING", kind: "defect", location: "src/limit.ts:10", evidence: "e", fix: "f", scope: "unit", ...over,
});

export const agg = (over: Partial<AggregateFinding> = {}): AggregateFinding => ({
	...finding(), from: ["r1:0"], needsDecision: false, route: "unit", routeUnit: "U2", verify: "required", ...over,
});

export const run = (over: Partial<ReviewRunData> = {}): MarkedComment =>
	mark(reviewRunComment({ round: 1, head: "h1", selected: ["change"], tags: [], verify: {}, parentFindings: [], routed: false, ...over }));

export const aggregate = (findings: AggregateFinding[], round = 1, head = "h1"): MarkedComment =>
	mark(aggregateComment({ round, head, reviews: ["r1"], findings }));

export const verifier = (key: string, over: Partial<FindingSummaryData> = {}): MarkedComment =>
	mark(findingSummaryComment({
		role: "verifier", subject: "change", round: 1, status: "DONE", advisory: false, head: "h1", packet: "p", sources_used: [], required: [], completed: true,
		agentSource: "s", requested: { thinking: "low" }, effective: {}, findings: [], verifies: key, verdict: "confirmed", reason: "r", ...over,
	}));

export const rebut = (commentId: string, index: number): MarkedComment => mark(rebuttalComment({ rebuts: commentId, items: [{ index, reason: "r", evidence: "e" }] }));

export const stuckReport = (id: string): MarkedComment => mark(writeMarked("stuck", id, { where: "review", tried: [], hypothesis: "h", options: [], recommended: "A" }));

export const stuckAnswer = (id: string, outcome = "approved", choice = "A"): MarkedComment =>
	mark(writeMarked("stuck", `${id}-answer`, { request: `stuck-${id}.x`, outcome, choice, notes: "", by: "alice", at: "t", adapter: "forge" }));
