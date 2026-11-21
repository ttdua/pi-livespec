// Derived status of aggregate findings, the `review_rounds` cap and the `review-clean` check (design D6, D8).

import type { Question } from "../core/change.ts";
import type { Result } from "../core/result.ts";
import { ANSWER_SUFFIX, isStuckReport, liftsCap } from "../engine/iterations.ts";
import { type CheckFn, registerCheck } from "../engine/registry.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { type AggregateFinding, aggregateFinding, answeredFindingKeys, findingKey, isBlocking, rebuttedKeys } from "../subagents/records.ts";
import { aggregates, latestRun, verifierRecord } from "./records.ts";

export type FindingState = "disputed" | "rebutted" | "answered" | "unverified" | "blocking" | "open";

const NEVER_BLOCKS = new Set<AggregateFinding["route"]>(["out-of-scope", "record"]);
/** Routes whose blocking findings count for the cap; a `question` finding waits for its answer instead. */
const CAP_ROUTES = new Set<AggregateFinding["route"]>(["unit", "in-change"]);

/** The verifier's verdict on a finding that needs it; a `BLOCKED` run confirms (fail closed), no completed or blocked run is no verdict. */
function verdictOf(marked: MarkedComment[], key: string): "confirmed" | "refuted" | undefined {
	const record = verifierRecord(marked, key);
	if (record === undefined) return undefined;
	return record.completed && record.verdict === "refuted" ? "refuted" : "confirmed";
}

/** The derived state of aggregate finding `index` of `aggregateCommentId`; `open` never blocks. */
export function findingState(marked: MarkedComment[], aggregateCommentId: string, index: number, questions: Question[]): FindingState {
	const key = findingKey(aggregateCommentId, index);
	const finding = aggregateFinding(marked, key)?.finding;
	if (finding === undefined) return "open";
	// Only findings sent to the verifier can be disputed: a refutation of a parent or missed-context finding is ignored.
	const verdict = finding.verify === "required" ? verdictOf(marked, key) : "confirmed";
	if (verdict === "refuted") return "disputed";
	if (!isBlocking(finding) || NEVER_BLOCKS.has(finding.route)) return "open";
	if (finding.kind !== "missed-context" && rebuttedKeys(marked).has(key)) return "rebutted";
	if (finding.route === "question" && answeredFindingKeys(questions).has(key)) return "answered";
	return verdict === undefined ? "unverified" : "blocking";
}

/** The aggregate's findings that block the review gate: `blocking` and `unverified` ones. */
export function blockingFindings(marked: MarkedComment[], aggregateCommentId: string, questions: Question[]): { index: number; finding: AggregateFinding }[] {
	const found = aggregates(marked).find((a) => a.commentId === aggregateCommentId);
	if (found === undefined) return [];
	return (found.data.findings as AggregateFinding[]).flatMap((finding, index) => {
		const state = findingState(marked, aggregateCommentId, index, questions);
		return state === "blocking" || state === "unverified" ? [{ index, finding }] : [];
	});
}


const countAfter = (marked: MarkedComment[], lift: number): number => aggregates(marked).filter((a) => a.at > lift).length;

/**
 * The comment index after which aggregates count: the latest lifting answer to a stuck report sent while the cap
 * blocked (design D8: derived from record order). One forward pass, so each report is judged with the lift known then.
 */
function liftIndex(marked: MarkedComment[], cap: number): number {
	const cappedReports = new Set<string>();
	let lift = -1;
	marked.forEach((m, i) => {
		const before = marked.slice(0, i);
		if (isStuckReport(m) && countAfter(before, lift) >= cap && latestRoundBlocks(before)) cappedReports.add(m.id);
		if (liftsCap(m) && cappedReports.has(m.id.slice(0, -ANSWER_SUFFIX.length))) lift = i;
	});
	return lift;
}

/** True when the latest routed round's aggregate left a blocking `unit` or `in-change` finding. */
function latestRoundBlocks(marked: MarkedComment[]): boolean {
	const latest = aggregates(marked).at(-1);
	const run = latestRun(marked);
	if (latest === undefined || run === undefined || !run.routed || run.round !== latest.data.round) return false;
	return blockingFindings(marked, latest.commentId, []).some((b) => CAP_ROUTES.has(b.finding.route));
}

/**
 * `review_rounds`: every aggregate newer than the latest lifting stuck answer sent while the cap blocked.
 * The cap blocks when the count reached it, the latest round is routed and its aggregate left a blocking `unit` or `in-change` finding.
 */
export function reviewRounds(marked: MarkedComment[], cap: number | undefined): { value: number; blocking: boolean } {
	const value = countAfter(marked, cap === undefined ? -1 : liftIndex(marked, cap));
	return { value, blocking: cap !== undefined && value >= cap && latestRoundBlocks(marked) };
}

const CHECK = "review-clean";
const fail = (message: string): Result[] => [{ code: CHECK, severity: "error", message }];
const describe = (b: { index: number; finding: AggregateFinding }): string => `${b.index} (${b.finding.severity} ${b.finding.kind} at ${untrusted(b.finding.location)}, ${b.finding.route})`;

/** Passes only when the latest aggregate reviewed HEAD and none of its findings blocks. */
const reviewClean: CheckFn = async ({ change, git, marked }) => {
	const head = await git.head();
	const latest = aggregates(marked).at(-1);
	if (latest === undefined) return fail(`no review round has reviewed HEAD ${head}; run spec_review.`);
	if (latest.data.head !== head) return fail(`review round ${latest.data.round} reviewed ${latest.data.head}, not HEAD ${head}; run spec_review.`);
	const blocking = blockingFindings(marked, latest.commentId, change.questions);
	if (blocking.length === 0) return [];
	return fail(`review round ${latest.data.round} at HEAD has blocking findings: ${blocking.map(describe).join("; ")}.`);
};

/** Gate-only, so it never preempts the review next steps but still refuses the self gate. */
export function registerReviewClean(): void {
	registerCheck(CHECK, reviewClean, { at: "gate" });
}
