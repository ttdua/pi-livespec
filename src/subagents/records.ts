// Forge records of subagent runs: `dispatch` and `finding-summary` comments, and the queries the flow reads from them.

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
};

/** A child's question, or its answer; both carry the agent id that links them to the later result. */
export type DispatchQuestionData =
	| { status: "QUESTION"; role: Role; unit?: string; agentId: string; attempt?: number; question: string }
	| { status: "ANSWERED"; role: Role; unit?: string; agentId: string; attempt?: number; answer: string };

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

export function dispatchComment(data: DispatchData | DispatchQuestionData): string {
	const scope = token(data.unit ?? CHANGE_LEVEL);
	const suffix = data.status === "QUESTION" || data.status === "ANSWERED" ? `.${data.status.toLowerCase()}` : "";
	return writeMarked("dispatch", `dispatch.${scope}.${data.role}.${data.attempt ?? 0}${suffix}`, data);
}

export function findingSummaryComment(data: FindingSummaryData): string {
	const scope = token(data.unit ?? CHANGE_LEVEL);
	return writeMarked("finding-summary", `finding-summary.${scope}.${token(data.subject)}.${data.round}`, data);
}

export function rebuttalComment(data: RebuttalData): string {
	return writeMarked("finding-summary", `finding-summary.rebut.${token(data.rebuts)}`, data);
}

const isResultRecord = (m: MarkedComment): boolean => {
	if (m.kind !== "dispatch") return false;
	const status = (m.data as { status?: unknown }).status;
	return status !== "QUESTION" && status !== "ANSWERED";
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
function current(marked: MarkedComment[]): MarkedComment[] {
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

type Summary = { commentId: string; at: number; data: FindingSummaryData };

function summariesOf(marked: MarkedComment[]): Summary[] {
	const found: Summary[] = [];
	current(marked).forEach((m, at) => {
		if (m.kind === "finding-summary" && Array.isArray((m.data as FindingSummaryData).findings)) found.push({ commentId: m.commentId, at, data: m.data as FindingSummaryData });
	});
	return found;
}

/** Rebuttals as `commentId:index` keys; a `missed-context` finding is never rebutted, so its key is dropped by the caller. */
function rebuttedKeys(marked: MarkedComment[]): Set<string> {
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
	const later = all.filter((o) => o.at > s.at && o.data.completed && !o.data.advisory && o.data.unit === s.data.unit && o.data.subject === s.data.subject);
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
		if (s.data.unit !== unit || s.data.advisory) continue;
		s.data.findings.forEach((finding, index) => {
			if (!isBlocking(finding)) return;
			if (finding.kind !== "missed-context" && rebutted.has(findingKey(s.commentId, index))) return;
			if (routed(s, finding, index, answered, gatesShown) || fixedByLaterReview(s, finding, all)) return;
			open.push({ comment: s.commentId, index, finding });
		});
	}
	return open;
}

/** True when a completed unit review of `unit` records one of `commits` (HEAD, plus a lane merge's second parent). */
export function completedReviewAt(marked: MarkedComment[], unit: string, commits: string[]): boolean {
	return summariesOf(marked).some(
		(s) => s.data.role === "reviewer" && s.data.subject === "unit" && s.data.unit === unit && s.data.completed && !s.data.advisory && commits.includes(s.data.head),
	);
}

/** The latest launched run whose last record is an unanswered `QUESTION`; rebuilt from comments only. */
export function pendingQuestion(marked: MarkedComment[]): PendingQuestion | undefined {
	const lastByAgent = new Map<string, MarkedComment>();
	for (const m of current(marked)) {
		if (m.kind !== "dispatch" && m.kind !== "finding-summary") continue;
		const agentId = (m.data as { agentId?: unknown } | null)?.agentId;
		if (typeof agentId === "string") lastByAgent.delete(agentId), lastByAgent.set(agentId, m);
	}
	const open = [...lastByAgent.values()].filter((m) => m.kind === "dispatch" && (m.data as { status?: unknown }).status === "QUESTION");
	const data = open.at(-1)?.data as Extract<DispatchQuestionData, { status: "QUESTION" }> | undefined;
	if (data === undefined) return undefined;
	return { ...(data.unit === undefined ? {} : { unit: data.unit }), role: data.role, agentId: data.agentId, question: data.question };
}
