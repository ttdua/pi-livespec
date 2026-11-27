// Forge records of subagent runs: `dispatch` and `finding-summary` comments, and the queries the flow reads from them.

import type { Question } from "../core/change.ts";
import { type MarkedComment, registerKind, writeMarked } from "../forge/markers.ts";
import { isDispatchData, isSummaryData } from "./validate.ts";
import type { Finding, ReviewSubject, Role, SubagentResult } from "./roles.ts";

registerKind("dispatch");

export type Thinking = "low" | "medium" | "high";

/** A settled implementer or scout run. */
export type DispatchData = {
	role: Role;
	unit?: string;
	subject?: ReviewSubject;
	agentId?: string;
	attempt: number;
	packet: string;
	agentSource: string;
	requested: { thinking: Thinking };
	effective: { model?: string; thinking?: string };
	status: SubagentResult["status"];
	commits: string[];
	notes: string;
	discoveries: string[];
	sources_used: string[];
	/** The child's `reason` and `evidence` of a `BLOCKED` or `NEEDS_CONTEXT` result, or the parent's for a launch mismatch. */
	reason?: string;
	evidence?: string;
	/** Set only by the parent for a post-launch mismatch: no child result, no attempt. */
	launchMismatch?: true;
	/** The unit's n-th `NEEDS_CONTEXT` request (set by the parent): no failed attempt, so the attempt is not raised. */
	contextRequest?: number;
};

/** A parent-made launch-mismatch record: evidence only, never a settled run. */
export const isLaunchMismatch = (d: unknown): boolean => (d as { launchMismatch?: unknown } | null)?.launchMismatch === true;

/** A child's question, or its answer; both carry the agent id that links them to the later result. */
export type DispatchQuestionData =
	| { status: "QUESTION"; role: Role; unit?: string; subject?: ReviewSubject; finding?: string; agentId: string; attempt?: number; question: string; launch?: QuestionLaunch }
	| { status: "ANSWERED"; role: Role; unit?: string; agentId: string; attempt?: number; answer: string }
	| { status: "RETRY"; role: Role; unit?: string; subject?: ReviewSubject; finding?: string; agentId: string; newAgentId: string; attempt: number; reason: string };

/** An open or settled `QUESTION` record. */
export type QuestionData = Extract<DispatchQuestionData, { status: "QUESTION" }>;

/** The run a question belongs to: role, unit, subject and verified finding. */
export type QuestionTarget = { role: Role; unit?: string; subject?: ReviewSubject; finding?: string };

/** Statuses of parent-made records that are no settled run and no attempt. */
export const NON_RUN_STATUSES: readonly string[] = ["QUESTION", "ANSWERED", "RETRY"];

/** What `subagent_answer` needs to record the resumed run as the dispatch would have: the packet and the launch facts. */
export type QuestionLaunch = { packet: string; agentSource: string; requested: { thinking: Thinking }; effective: { model?: string; thinking?: string }; advisory?: boolean };

export type FindingSummaryData = {
	role: Role;
	subject: ReviewSubject;
	unit?: string;
	agentId?: string;
	round: number;
	status: SubagentResult["status"];
	advisory: boolean;
	head: string;
	packet: string;
	sources_used: string[];
	required: string[];
	completed: boolean;
	agentSource: string;
	requested: { thinking: Thinking };
	effective: { model?: string; thinking?: string };
	findings: Finding[];
	/** The unit's n-th `NEEDS_CONTEXT` request of this role (set by the parent): no review round is used. */
	contextRequest?: number;
	/** Set only by lane code for a record the parent makes itself: never a review, a round or a resolution of other findings. */
	system?: "files-violation";
	/** A verifier record: the finding key it verifies and its verdict. */
	verifies?: string;
	verdict?: "confirmed" | "refuted";
	/** The run's own reason, notes and evidence, kept for every role; absent when empty. */
	reason?: string;
	notes?: string;
	evidence?: string;
	/** An aggregate of one review round: `findings` are `AggregateFinding`s and `reviews` the comment ids it merged. */
	aggregate?: true;
	reviews?: string[];
};

/** An aggregate finding: a reviewer finding plus the routing facts of the review stage. */
export type AggregateFinding = Finding & {
	from: string[];
	needsDecision: boolean;
	route: "unit" | "in-change" | "out-of-scope" | "question" | "record";
	routeUnit?: string;
	verify: "required" | "skipped-missed-context" | "skipped-parent" | "skipped-suggestion" | "skipped-off";
};

export type RebuttalData = { rebuts: string; items: { index: number; reason: string; evidence: string }[] };

export type PendingQuestion = { unit?: string; role: Role; agentId: string; question: string };

export type UnresolvedFinding = { comment: string; index: number; finding: Finding };

const COMPLETED_STATUSES = ["DONE", "DONE_WITH_CONCERNS"];
const CHANGE_LEVEL = "change";

/** Marker ids allow only `[A-Za-z0-9._-]`; anything else (e.g. the `:` of `persona:x`) becomes `-`. */
const token = (value: string | number): string => String(value).replace(/[^A-Za-z0-9._-]/g, "-");

/** The key `unresolvedBlocking` expects in `answered` and `gatesShown`: one finding of one summary comment. */
export const findingKey = (commentId: string, index: number): string => `${commentId}:${index}`;

/** Mismatch and NEEDS_CONTEXT records keep the attempt number, so each needs its own id to not supersede the attempt's run record. */
function runSuffix(data: DispatchData): string {
	if (data.launchMismatch === true) return ".mismatch";
	return data.contextRequest === undefined ? "" : `.needs-context-${data.contextRequest}`;
}

export function dispatchComment(data: DispatchData | DispatchQuestionData): string {
	const scope = token(data.unit ?? CHANGE_LEVEL);
	if (data.status === "RETRY") return writeMarked("dispatch", `dispatch.${scope}.${data.role}.retry.${token(data.newAgentId)}`, data);
	// A question and its answer name their child: two children of one role and attempt (verifiers of other findings) must not supersede each other. Older comments without the child still read.
	const suffix = data.status === "QUESTION" || data.status === "ANSWERED" ? `.${data.status.toLowerCase()}.${token(data.agentId)}` : runSuffix(data);
	return writeMarked("dispatch", `dispatch.${scope}.${data.role}.${data.attempt ?? 0}${suffix}`, data);
}

export function findingSummaryComment(data: FindingSummaryData): string {
	const scope = token(data.unit ?? CHANGE_LEVEL);
	const suffix = data.contextRequest === undefined ? "" : `.needs-context-${data.contextRequest}`;
	// System summaries have their own namespace: a later review of the same round never supersedes them.
	if (data.role === "verifier" && data.verifies !== undefined) return writeMarked("finding-summary", `finding-summary.verify.${token(data.verifies)}.${data.round}${suffix}`, data);
	const subject = data.system === undefined ? token(data.subject) : `system.${token(data.system)}`;
	return writeMarked("finding-summary", `finding-summary.${scope}.${subject}.${data.round}${suffix}`, data);
}

export function rebuttalComment(data: RebuttalData): string {
	return writeMarked("finding-summary", `finding-summary.rebut.${token(data.rebuts)}`, data);
}

const isResultRecord = (m: MarkedComment): boolean => {
	if (m.kind !== "dispatch") return false;
	const status = (m.data as { status?: unknown }).status;
	return !NON_RUN_STATUSES.includes(status as string) && !isLaunchMismatch(m.data);
};

/** The unit's latest settled `dispatch` record (questions and answers excluded), optionally of one role. */
export function latestDispatch(marked: MarkedComment[], unit: string, role?: Role): DispatchData | undefined {
	const found = current(marked).filter((m) => {
		if (!isResultRecord(m)) return false;
		const data = m.data as DispatchData;
		return data.unit === unit && (role === undefined || data.role === role);
	});
	return found.at(-1)?.data as DispatchData | undefined;
}

/** A completed review has status `DONE` or `DONE_WITH_CONCERNS` and every required source in `sources_used`. */
export function computeCompleted(result: Pick<SubagentResult, "status" | "sources_used">, required: string[]): boolean {
	return COMPLETED_STATUSES.includes(result.status) && required.every((id) => result.sources_used.includes(id));
}

const VALID: Record<string, (d: unknown) => boolean> = { dispatch: isDispatchData, "finding-summary": isSummaryData };

/** Own `dispatch` and `finding-summary` records whose data does not have the expected shape. */
export function invalidRecords(marked: MarkedComment[]): string[] {
	return marked.filter((m) => m.kind in VALID && !(VALID[m.kind] as (d: unknown) => boolean)(m.data)).map((m) => `ignored invalid ${m.kind} record ${m.commentId} (${m.id})`);
}

/** Valid records only, and of those the latest comment per marker identity: superseded comments are history. */
export function current(marked: MarkedComment[]): MarkedComment[] {
	const latest = new Map<string, MarkedComment>();
	for (const m of marked) {
		const valid = VALID[m.kind];
		if (valid === undefined || !valid(m.data)) continue;
		const key = `${m.kind}:${m.id}`;
		latest.delete(key);
		latest.set(key, m);
	}
	const kept = new Set(latest.values());
	return marked.filter((m) => kept.has(m));
}

const isAggregate = (d: FindingSummaryData): boolean => d.aggregate === true;

/** The aggregate `finding-summary` named by the key's comment id, and the finding at the key's index. */
export function aggregateFinding(marked: MarkedComment[], key: string): { commentId: string; index: number; finding: AggregateFinding } | undefined {
	const cut = key.lastIndexOf(":");
	const commentId = key.slice(0, cut);
	const index = Number(key.slice(cut + 1));
	if (cut <= 0 || !Number.isInteger(index) || index < 0) return undefined;
	const found = summariesOf(marked).find((s) => s.commentId === commentId && isAggregate(s.data));
	const finding = found?.data.findings[index];
	return finding === undefined ? undefined : { commentId, index, finding: finding as AggregateFinding };
}

type Summary = { commentId: string; at: number; data: FindingSummaryData };

/** A parent-made record (a `Files` violation): it carries findings, but is no review of any commit. */
const isSystem = (d: FindingSummaryData): boolean => d.system === "files-violation";

/** Verifier and aggregate records are neither reviews nor resolutions: the unit and change readers skip them. */
const isDerived = (d: FindingSummaryData): boolean => isSystem(d) || d.role === "verifier" || d.aggregate === true;

function summariesOf(marked: MarkedComment[]): Summary[] {
	const found: Summary[] = [];
	current(marked).forEach((m, at) => {
		if (m.kind === "finding-summary" && Array.isArray((m.data as FindingSummaryData).findings)) found.push({ commentId: m.commentId, at, data: m.data as FindingSummaryData });
	});
	return found;
}

/** Rebuttals as `commentId:index` keys; a `missed-context` finding is never rebutted, so its key is dropped by the caller. */
export function rebuttedKeys(marked: MarkedComment[]): Set<string> {
	const keys = new Set<string>();
	for (const m of current(marked)) {
		const data = m.kind === "finding-summary" ? (m.data as Partial<RebuttalData>) : null;
		if (!data || typeof data.rebuts !== "string" || !Array.isArray(data.items)) continue;
		for (const item of data.items) keys.add(findingKey(data.rebuts, item.index));
	}
	return keys;
}

export const isBlocking = (f: Finding): boolean => f.severity === "CRITICAL" || f.severity === "WARNING" || f.kind === "missed-context";

const sameSpot = (a: Finding, b: Finding): boolean => a.location === b.location && a.kind === b.kind;

/** True when the latest completed round after `s` for the same unit and subject no longer reports `f`. */
function fixedByLaterReview(s: Summary, f: Finding, all: Summary[]): boolean {
	if (isDerived(s.data)) return false;
	const later = all.filter((o) => o.at > s.at && o.data.completed && !o.data.advisory && !isDerived(o.data) && o.data.unit === s.data.unit && o.data.subject === s.data.subject);
	const latest = later.at(-1);
	return latest !== undefined && !latest.data.findings.some((g) => isBlocking(g) && sameSpot(f, g));
}

function routed(s: Summary, f: Finding, index: number, answered: Set<string>, gatesShown: Set<string>): boolean {
	const key = findingKey(s.commentId, index);
	if (f.scope === "needs-decision") return answered.has(key);
	if (f.scope === "out-of-scope") return gatesShown.has(key);
	return false;
}

/**
 * Blocking findings of the unit that no later completed review, rebuttal, answered `needs-decision` question
 * or shown `out-of-scope` gate resolves. Findings of advisory summaries never block.
 */
export function unresolvedBlocking(marked: MarkedComment[], unit: string, answered: Set<string>, gatesShown: Set<string>): UnresolvedFinding[] {
	const all = summariesOf(marked);
	const rebutted = rebuttedKeys(marked);
	const open: UnresolvedFinding[] = [];
	for (const s of all) {
		if (s.data.unit !== unit || s.data.advisory || isDerived(s.data)) continue;
		s.data.findings.forEach((finding, index) => {
			if (!isBlocking(finding)) return;
			if (finding.kind !== "missed-context" && rebutted.has(findingKey(s.commentId, index))) return;
			if (routed(s, finding, index, answered, gatesShown) || fixedByLaterReview(s, finding, all)) return;
			open.push({ comment: s.commentId, index, finding });
		});
	}
	return open;
}

/**
 * The findings that refuse `unit_finish`: unresolved blocking findings except `out-of-scope` ones, which never refuse
 * the tick and are listed at the next human gate instead (spec `review-findings` "Blocking findings").
 */
export function tickBlocking(marked: MarkedComment[], unit: string, answered: Set<string>): UnresolvedFinding[] {
	return unresolvedBlocking(marked, unit, answered, new Set()).filter((o) => o.finding.scope !== "out-of-scope");
}

/** True when a completed unit review of `unit` records one of `commits` (HEAD, plus a lane merge's second parent). */
export function completedReviewAt(marked: MarkedComment[], unit: string, commits: string[]): boolean {
	return summariesOf(marked).some(
		(s) => !isDerived(s.data) && s.data.role === "reviewer" && s.data.subject === "unit" && s.data.unit === unit && s.data.completed && !s.data.advisory && commits.includes(s.data.head),
	);
}

/** True when a completed unit review of `unit` at one of `commits` has the given advisory flag: the review step is done. Blocking and required semantics stay in `completedReviewAt`. */
export function reviewStepDoneAt(marked: MarkedComment[], unit: string, commits: string[], advisory: boolean): boolean {
	return summariesOf(marked).some(
		(s) => !isDerived(s.data) && s.data.role === "reviewer" && s.data.subject === "unit" && s.data.unit === unit && s.data.completed && s.data.advisory === advisory && commits.includes(s.data.head),
	);
}

/** True when a completed review of the whole-change `subject` (`spec`, `plan`, `change`, a persona) records `head`. */
export function changeReviewDoneAt(marked: MarkedComment[], subject: ReviewSubject, head: string): boolean {
	return summariesOf(marked).some((s) => !isDerived(s.data) && s.data.role === "reviewer" && s.data.subject === subject && s.data.unit === undefined && s.data.completed && s.data.head === head);
}

/** True when `marked` holds a settled `dispatch` record of `role` (questions, answers and launch mismatches excluded). */
export function settledRunSince(marked: MarkedComment[], role: Role): boolean {
	return current(marked).some((m) => isResultRecord(m) && (m.data as DispatchData).role === role);
}

/** Valid, current, completed, non-advisory unit reviews of `unit`; rebuttals and superseded comments never count. */
export function completedUnitRounds(marked: MarkedComment[], unit: string): number {
	return summariesOf(marked).filter((s) => !isDerived(s.data) && s.data.role === "reviewer" && s.data.subject === "unit" && s.data.unit === unit && s.data.completed && !s.data.advisory).length;
}

const FINDING_REF = /finding:([^\s:]+:\d+)/g;

/** Finding keys named as `finding:<commentId>:<index>` in the text of an answered question. */
export function answeredFindingKeys(questions: Question[]): Set<string> {
	const keys = new Set<string>();
	for (const q of questions) if (q.checked) for (const m of q.text.matchAll(FINDING_REF)) keys.add(m[1] as string);
	return keys;
}

/** Findings of parent-made system summaries (never blocking) that no completed gate has shown yet, as `commentId:index` keys. */
export function unshownSystemFindings(marked: MarkedComment[], gatesShown: Set<string>): { key: string; finding: Finding }[] {
	return summariesOf(marked).filter((s) => isSystem(s.data)).flatMap((s) => s.data.findings.map((finding, i) => ({ key: findingKey(s.commentId, i), finding }))).filter((o) => !gatesShown.has(o.key));
}

/** Units with a valid, current non-advisory review summary. */
export function reviewedUnits(marked: MarkedComment[]): string[] {
	return [...new Set(summariesOf(marked).filter((s) => !s.data.advisory && s.data.unit !== undefined).map((s) => s.data.unit as string))];
}

/** Finding keys recorded in the `findings` of `gate` comments (written when a gate completes); malformed lists are ignored. */
export function gatesShownKeys(marked: MarkedComment[]): Set<string> {
	const keys = new Set<string>();
	for (const m of marked) {
		const list = m.kind === "gate" ? (m.data as { findings?: unknown } | null)?.findings : undefined;
		if (Array.isArray(list) && list.every((k) => typeof k === "string")) for (const k of list) keys.add(k as string);
	}
	return keys;
}

/** Open `QUESTION`s (the asking agent's last record is the question), oldest first; rebuilt from comments only. */
export function openQuestions(marked: MarkedComment[]): QuestionData[] {
	const lastByAgent = new Map<string, MarkedComment>();
	for (const m of current(marked)) {
		if (m.kind !== "dispatch" && m.kind !== "finding-summary") continue;
		const agentId = (m.data as { agentId?: unknown } | null)?.agentId;
		if (typeof agentId === "string") lastByAgent.delete(agentId), lastByAgent.set(agentId, m);
	}
	return [...lastByAgent.values()].filter((m) => m.kind === "dispatch" && (m.data as { status?: unknown }).status === "QUESTION").map((m) => m.data as QuestionData);
}

const toPending = (data: QuestionData): PendingQuestion => ({ ...(data.unit === undefined ? {} : { unit: data.unit }), role: data.role, agentId: data.agentId, question: data.question });

/** The latest open question of any target. */
export function pendingQuestion(marked: MarkedComment[]): PendingQuestion | undefined {
	const data = openQuestions(marked).at(-1);
	return data === undefined ? undefined : toPending(data);
}

/** The latest open question of exactly the target `t` (role, unit, subject and finding). */
export function pendingQuestionFor(marked: MarkedComment[], t: QuestionTarget): PendingQuestion | undefined {
	const data = openQuestions(marked).filter((q) => q.role === t.role && q.unit === t.unit && q.subject === t.subject && q.finding === t.finding).at(-1);
	return data === undefined ? undefined : toPending(data);
}

/** True when `agentId` was launched as the fallback of an earlier child: a `RETRY` record names it as `newAgentId`. */
export function isFallbackChild(marked: MarkedComment[], agentId: string): boolean {
	return current(marked).some((m) => m.kind === "dispatch" && (m.data as { status?: unknown; newAgentId?: unknown }).status === "RETRY" && (m.data as { newAgentId?: unknown }).newAgentId === agentId);
}

/** The `QUESTION` record of `agentId` when it is the agent's latest record, so the question is still open. */
export function pendingQuestionOf(marked: MarkedComment[], agentId: string): Extract<DispatchQuestionData, { status: "QUESTION" }> | undefined {
	const last = current(marked).filter((m) => (m.kind === "dispatch" || m.kind === "finding-summary") && (m.data as { agentId?: unknown } | null)?.agentId === agentId).at(-1);
	const data = last?.kind === "dispatch" ? (last.data as DispatchQuestionData) : undefined;
	return data?.status === "QUESTION" ? data : undefined;
}
