// The forge record of one settled run, dispatched or inline: a `dispatch` comment for writers and scouts, a `finding-summary` for reviewers and verifiers.

import type { MarkedComment } from "../forge/markers.ts";
import { computeCompleted, current, isLaunchMismatch, NON_RUN_STATUSES, type DispatchData, dispatchComment, findingSummaryComment, type FindingSummaryData, type Thinking } from "./records.ts";
import type { ReviewSubject, Role, SubagentResult } from "./roles.ts";
import type { Packet } from "./source-types.ts";

/** Everything about a run that is not the child's result. `agentId` is absent for an inline run. */
export type RunFacts = {
	role: Role;
	unit?: string;
	subject?: ReviewSubject;
	agentId?: string;
	attempt: number;
	round: number;
	packet: Packet;
	agentSource: string;
	requested: { thinking: Thinking };
	effective: { model?: string; thinking?: string };
	advisory: boolean;
	/** The aggregate finding key a verifier checks. */
	finding?: string;
	/** The unit's earlier `NEEDS_CONTEXT` records of this role; a new one is numbered after them. */
	needsContext: number;
};

export const INLINE_SOURCE = "inline";

/** The reason of the `BLOCKED` record a post-launch mismatch leaves; such a record is no attempt. */
export const LAUNCH_MISMATCH = "launch-mismatch";

const isReviewRole = (role: Role): boolean => role === "reviewer" || role === "verifier";

/** Next `attempt` of a dispatch record for the unit and role: one more than the settled records so far. */
export function nextAttempt(marked: MarkedComment[], role: Role, unit: string | undefined): number {
	return current(marked).filter((m) => {
		const d = m.data as Partial<DispatchData>;
		const settled = d.status !== undefined && !NON_RUN_STATUSES.includes(d.status);
		return m.kind === "dispatch" && d.role === role && d.unit === unit && settled && !isLaunchMismatch(d) && d.contextRequest === undefined;
	}).length + 1;
}

/** Next `round` of a finding summary for the unit, role and subject. */
export function nextRound(marked: MarkedComment[], role: Role, unit: string | undefined, subject: ReviewSubject | undefined): number {
	return current(marked).filter((m) => {
		const d = m.data as Partial<FindingSummaryData> & { rebuts?: unknown };
		return m.kind === "finding-summary" && d.rebuts === undefined && d.contextRequest === undefined && d.system !== "files-violation" && d.aggregate !== true && d.role === role && d.unit === unit && d.subject === subject;
	}).length + 1;
}

/** Next `round` of a verifier record: one more than the verifier records of the same finding key. */
export function nextVerifyRound(marked: MarkedComment[], key: string): number {
	return current(marked).filter((m) => m.kind === "finding-summary" && (m.data as Partial<FindingSummaryData>).verifies === key && (m.data as Partial<FindingSummaryData>).contextRequest === undefined).length + 1;
}

/** Earlier `NEEDS_CONTEXT` records of the unit and role, `dispatch` or `finding-summary`: the cap counts these only. */
export function needsContextCount(marked: MarkedComment[], unit: string | undefined, role: Role): number {
	return current(marked).filter((m) => {
		const d = m.data as Partial<DispatchData>;
		return (m.kind === "dispatch" || m.kind === "finding-summary") && d.unit === unit && d.role === role && d.status === "NEEDS_CONTEXT";
	}).length;
}

/** The parent's number of a `NEEDS_CONTEXT` result; it keeps the record off the attempt and round counters. */
const contextRequestOf = (run: RunFacts, result: SubagentResult): { contextRequest?: number } => (result.status === "NEEDS_CONTEXT" ? { contextRequest: run.needsContext + 1 } : {});

const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> => (value === undefined ? {} : ({ [key]: value } as Record<K, V>));

function dispatchData(run: RunFacts, result: SubagentResult): DispatchData {
	const notes = [result.notes, result.reason ? `Reason: ${result.reason}` : "", result.evidence ? `Evidence: ${result.evidence}` : ""].filter(Boolean).join("\n");
	return {
		role: run.role, ...optional("unit", run.unit), ...optional("subject", run.subject), ...optional("agentId", run.agentId),
		attempt: run.attempt, packet: run.packet.hash, agentSource: run.agentSource, requested: run.requested, effective: run.effective,
		status: result.status, commits: result.commits ?? [], notes, discoveries: result.discoveries, sources_used: result.sources_used,
		...optional("reason", result.reason), ...optional("evidence", result.evidence),
		...contextRequestOf(run, result),
	};
}

/** The parent's record of a post-launch mismatch, for every role: a `dispatch` comment, never a review round. */
export function mismatchComment(run: RunFacts, notes: string, evidence: string): string {
	const result = { ...blockedResult(LAUNCH_MISMATCH), notes, evidence };
	return dispatchComment({ ...dispatchData(run, result), launchMismatch: true });
}

function summaryData(run: RunFacts, result: SubagentResult, head: string): FindingSummaryData {
	const required = run.packet.sources.filter((s) => s.required).map((s) => s.id);
	return {
		role: run.role, subject: run.subject ?? "change", ...optional("unit", run.unit), ...optional("agentId", run.agentId),
		round: run.round, status: result.status, advisory: run.advisory, head, packet: run.packet.hash,
		sources_used: result.sources_used, required, completed: computeCompleted(result, required),
		agentSource: run.agentSource, requested: run.requested, effective: run.effective, findings: result.findings ?? [],
		...whyFields(result), ...contextRequestOf(run, result), ...verifierFields(run, result),
	};
}

/** The run's own `notes`, `reason` and `evidence`; empty ones are left out. */
const whyFields = (result: SubagentResult): Partial<FindingSummaryData> => ({
	...optional("notes", result.notes || undefined), ...optional("reason", result.reason || undefined), ...optional("evidence", result.evidence || undefined),
});

/** `verifies` and `verdict` of a verifier record. */
function verifierFields(run: RunFacts, result: SubagentResult): Partial<FindingSummaryData> {
	if (run.role !== "verifier") return {};
	return { ...optional("verifies", run.finding), ...optional("verdict", result.verdict) };
}

/** The comment body that records `result`; `head` is the reviewed commit of a review run. */
export function runRecordComment(run: RunFacts, result: SubagentResult, head: string): string {
	return isReviewRole(run.role) ? findingSummaryComment(summaryData(run, result, head)) : dispatchComment(dispatchData(run, result));
}

/** A run that left no usable result, recorded as `BLOCKED` with the reason. */
export function blockedResult(reason: string): SubagentResult {
	return { status: "BLOCKED", notes: reason, discoveries: [], sources_used: [], reason, evidence: "recorded by the parent", commits: [], findings: [] };
}

/** The side effects of recording a run: one own comment, and git reads in the run's cwd. */
export type RecordDeps = {
	/** Posts one own comment on the change issue. */
	post(body: string): Promise<void>;
	/** HEAD of `cwd`: the reviewed commit of a review run. */
	headOf(cwd: string): Promise<string>;
	/** The claimed commits reachable from HEAD of `cwd`; the others are not evidence. */
	reachable(cwd: string, commits: string[]): Promise<string[]>;
};

/** Posts the record of `result`; claimed commits not reachable from HEAD of `cwd` are dropped and named in the notes. */
export async function recordResult(deps: RecordDeps, run: RunFacts, cwd: string, result: SubagentResult): Promise<SubagentResult> {
	const claimed = result.commits ?? [];
	const commits = await deps.reachable(cwd, claimed);
	const dropped = claimed.filter((c) => !commits.includes(c));
	const notes = dropped.length === 0 ? result.notes : `${result.notes}\nNot reachable from HEAD, not counted: ${dropped.join(", ")}`;
	const kept: SubagentResult = { ...result, notes, ...(result.commits === undefined ? {} : { commits }) };
	const head = isReviewRole(run.role) ? await deps.headOf(cwd) : "";
	await deps.post(runRecordComment(run, kept, head));
	return kept;
}
