// The review round's state machine (design D2): from the change state, which stage a `spec_review` call runs next,
// or why it refuses. Pure; every stage is derived from own marked comments.

import type { Pack } from "../engine/pack-types.ts";
import { liftsCap } from "../engine/iterations.ts";
import { blockingRequests } from "../engine/request-mode.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { reviewEntriesRunBySpecReview } from "../subagents/phase-entries.ts";
import { type AggregateFinding, current, type FindingSummaryData, findingKey } from "../subagents/records.ts";
import type { ReviewSubject } from "../subagents/roles.ts";
import { aggregateOf, aggregates, latestRun, type ReviewRunData, verifierRecord } from "./records.ts";
import { reviewRounds } from "./status.ts";

export type Stage = "start" | "review" | "aggregate" | "verify" | "route" | "done" | "refused";
export type NextStage = { stage: Stage; missing?: ReviewSubject[] | string[]; reason?: string };

type Run = ReviewRunData & { commentId: string };

const refused = (reason: string): NextStage => ({ stage: "refused", reason });

/** A round's number: the count of aggregate records plus one. */
export const roundNumber = (marked: MarkedComment[]): number => aggregates(marked).length + 1;

/** Whole-change reviewer summaries of `subject` at `head`, with their comment index, in comment order. */
function reviewerRuns(marked: MarkedComment[], subject: ReviewSubject, head: string): { at: number; commentId: string; data: FindingSummaryData }[] {
	return current(marked).flatMap((m) => {
		const d = m.data as FindingSummaryData;
		const ok = m.kind === "finding-summary" && d.role === "reviewer" && d.subject === subject && d.unit === undefined && d.aggregate !== true && d.head === head && Array.isArray(d.findings);
		return ok ? [{ at: marked.indexOf(m), commentId: m.ref, data: d }] : [];
	});
}

/** The latest completed reviewer summary of `subject` at `head`: what the aggregate merges. */
export function completedReview(marked: MarkedComment[], subject: ReviewSubject, head: string): { commentId: string; data: FindingSummaryData } | undefined {
	return reviewerRuns(marked, subject, head).filter((r) => r.data.completed).at(-1);
}

/** The latest run of `subject` at `head` ended `BLOCKED` and no lifting stuck answer came after it. */
export function stillBlocked(marked: MarkedComment[], subject: ReviewSubject, head: string): boolean {
	const latest = reviewerRuns(marked, subject, head).at(-1);
	if (latest === undefined || latest.data.completed || latest.data.status !== "BLOCKED") return false;
	return !marked.some((m, i) => i > latest.at && liftsCap(m));
}

/** Refusals that hold at every stage: the phase, Base, the tree, open questions, stuck reports and requests. */
function generalRefusal(state: ChangeState): string | undefined {
	const phase = state.phase.kind === "ok" ? state.phase.id : undefined;
	if (phase === undefined || !reviewEntriesRunBySpecReview(phase)) return `the change is in ${phase ?? "no single phase"}, not review; spec_review runs only in the review phase.`;
	if (state.change.header.base === undefined) return "the change has no Base line, so the review diff is unknown.";
	if (state.git.dirty) return "the working tree is dirty; commit or remove the changes first.";
	const question = state.change.questions.find((q) => q.kind === "blocking" && !q.checked);
	if (question !== undefined) return `blocking question ${question.id} is open; it must be answered first.`;
	if (state.iterations.stuckOpen !== undefined) return `stuck report ${state.iterations.stuckOpen} is unanswered; wait for the human's choice.`;
	const request = blockingRequests(state)[0];
	if (request !== undefined) return `request ${request.id} for ${request.subject} is pending; wait for its answer.`;
	const child = state.subagents.pending;
	if (child !== undefined) return `child ${child.agentId} asks a question; answer it with subagent_answer ${child.agentId} "<answer>" first.`;
	return undefined;
}

function unitsNotDone(state: ChangeState): string | undefined {
	const pending = state.change.units.filter((u) => !u.done).map((u) => u.id);
	return pending.length === 0 ? undefined : `${pending.join(", ")} ${pending.length === 1 ? "is" : "are"} not done; finish every unit before the review.`;
}

/** The start stage, unless a unit is pending or the `review_rounds` cap blocks. */
function startStage(state: ChangeState, pack: Pack): NextStage {
	const notDone = unitsNotDone(state);
	if (notDone !== undefined) return refused(notDone);
	const cap = pack.loops.review_rounds;
	const rounds = reviewRounds(state.marked, cap);
	if (rounds.blocking) return refused(`review_rounds reached ${rounds.value} of ${cap} and the last round left blocking findings; send a stuck report with spec_stuck.`);
	return { stage: "start" };
}

/** A round started at HEAD and not aggregated: launch the missing reviewers, or aggregate. */
function reviewStage(state: ChangeState, run: Run): NextStage {
	const notDone = unitsNotDone(state);
	if (notDone !== undefined) return refused(notDone);
	const head = state.git.head;
	const open = run.selected.filter((s) => completedReview(state.marked, s, head) === undefined);
	const blocked = open.filter((s) => stillBlocked(state.marked, s, head));
	const missing = open.filter((s) => !blocked.includes(s));
	if (missing.length > 0) return { stage: "review", missing };
	if (blocked.length > 0) return refused(`the ${blocked.join(", ")} reviewer ended BLOCKED at HEAD; send a stuck report with spec_stuck naming it.`);
	return { stage: "aggregate" };
}

/** An aggregated round: verify the findings that need it, then route. */
function laterStage(state: ChangeState, aggregate: { commentId: string; data: FindingSummaryData }): NextStage {
	const missing = (aggregate.data.findings as AggregateFinding[]).flatMap((f, i) => {
		const key = findingKey(aggregate.commentId, i);
		return f.verify === "required" && verifierRecord(state.marked, key) === undefined ? [key] : [];
	});
	return missing.length > 0 ? { stage: "verify", missing } : { stage: "route" };
}

/** Design D2: start, review, aggregate, verify, route, each skipped once its record exists for the current HEAD. */
export function nextStage(state: ChangeState, pack: Pack): NextStage {
	const general = generalRefusal(state);
	if (general !== undefined) return refused(general);
	const run = latestRun(state.marked);
	if (run === undefined) return startStage(state, pack);
	const aggregate = aggregateOf(state.marked, run.round);
	// A pull request feedback round is never replaced: it is aggregated and routed at its own head, whatever HEAD and the cap are now.
	if (run.source === "pull-request" && !run.routed) return aggregate === undefined ? { stage: "aggregate" } : laterStage(state, aggregate);
	// A round already aggregated always finishes, whatever HEAD and the cap are now.
	if (aggregate !== undefined && !run.routed) return laterStage(state, aggregate);
	if (run.routed) return run.head === state.git.head ? { stage: "done" } : startStage(state, pack);
	return run.head === state.git.head ? reviewStage(state, run) : startStage(state, pack);
}
