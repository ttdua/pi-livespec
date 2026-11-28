// Pure interpretation of a settled child run: accept, retry, return to the child, ask, or stop (spec "Result handling").

import { untrusted } from "../hooks/phase-card.ts";
import type { RecordLike } from "./executor.ts";
import { checkSchema, resultSchema, type Role, type SubagentResult } from "./roles.ts";
import type { Packet } from "./source-types.ts";

/** Retry and cap constants of the plan's Global Constraints. */
export const MISSING_RESULT_RETRIES = 1;
export const MISSING_SOURCE_RETURNS = 1;
export const NEEDS_CONTEXT_CAP = 2;
export const MISSING_PREREQUISITE = "missing-prerequisite";

/**
 * What came before this run. `needsContext` counts the unit's earlier `NEEDS_CONTEXT` dispatch records;
 * `retries` and `returns` count the steps already taken for the current dispatch.
 */
export type DispatchHistory = { needsContext: number; retries: number; returns: number; respawned: boolean };

export type ResultDecision =
	| { kind: "accept"; result: SubagentResult }
	/** `reason` is plain text; `shown` is the same with child text wrapped as untrusted, for the parent. */
	| { kind: "retry"; reason: string; shown: string }
	| { kind: "return"; missing: string[] }
	| { kind: "more-context"; ids: string[]; result: SubagentResult }
	| { kind: "question"; text: string }
	| { kind: "blocked"; reason: string }
	| { kind: "stuck"; reason: string; result?: SubagentResult; prerequisite?: true };

/** A source id as packets name them: `<kind>:<rest>` or `issue#<n>`. */
const SOURCE_ID = /(?:^|[\s,;(`'"])((?:[a-z]+:[^\s,;)`'"]+)|(?:issue#\d+))/g;

/** Source ids named in the reason and evidence of a `NEEDS_CONTEXT` result. */
export function namedSourceIds(result: SubagentResult): string[] {
	const text = `${result.reason ?? ""}\n${result.evidence ?? ""}`;
	return [...new Set([...text.matchAll(SOURCE_ID)].map((m) => (m[1] as string).replace(/[.:]$/, "")))];
}

/** Why a run left no usable result: `plain` feeds the retry, `shown` wraps child text as untrusted for the parent. */
type Missing = { plain: string; shown: string };

const same = (text: string): Missing => ({ plain: text, shown: text });

/** Why the run left no usable result, or undefined when its structured result fits the role's schema. */
function missingReason(record: RecordLike, role: Role): Missing | undefined {
	if (record.structuredResultError !== undefined) return same(`the structured result is ${record.structuredResultError}`);
	if (record.structuredResult === undefined) {
		if (record.error) return { plain: `the run ended with an error: ${record.error}`, shown: `the run ended with an error: ${untrusted(record.error)}` };
		return same(`the run ended (${record.status}) without a structured result`);
	}
	const check = checkSchema(resultSchema(role), record.structuredResult);
	const prefix = `the structured result does not match the ${role} schema: `;
	if (!check.ok) return { plain: prefix + check.errors.join("; "), shown: prefix + untrusted(check.errors.join("; ")) };
	const result = record.structuredResult as SubagentResult;
	const needsWhy = result.status === "BLOCKED" || result.status === "NEEDS_CONTEXT";
	if (needsWhy && (!result.reason || !result.evidence)) return same(`a ${result.status} result must carry reason and evidence`);
	return undefined;
}

function retryOrBlock(missing: Missing, history: DispatchHistory): ResultDecision {
	return history.retries < MISSING_RESULT_RETRIES ? { kind: "retry", reason: missing.plain, shown: missing.shown } : { kind: "blocked", reason: `no usable result after a retry: ${missing.shown}` };
}

/** Required source ids of the packet that `sources_used` omits. */
function missingSources(result: SubagentResult, packet: Packet): string[] {
	return packet.sources.filter((s) => s.required && !result.sources_used.includes(s.id)).map((s) => s.id);
}

/** A `BLOCKED` result whose reason names `missing-prerequisite`: a discovered dependency, not a failed attempt. */
export function isMissingPrerequisite(result: SubagentResult): boolean {
	return result.status === "BLOCKED" && result.reason?.includes(MISSING_PREREQUISITE) === true;
}

function statusDecision(result: SubagentResult, history: DispatchHistory): ResultDecision {
	if (result.status === "NEEDS_CONTEXT") {
		if (history.needsContext >= NEEDS_CONTEXT_CAP) return { kind: "stuck", reason: `NEEDS_CONTEXT returned ${history.needsContext + 1} times: ${untrusted(result.reason ?? "")}`, result };
		return { kind: "more-context", ids: namedSourceIds(result), result };
	}
	if (isMissingPrerequisite(result)) return { kind: "stuck", reason: `${MISSING_PREREQUISITE}: ${untrusted(result.evidence ?? "")}`, result, prerequisite: true };
	return { kind: "accept", result };
}

/** Decides what the parent does with a settled run; reads nothing but its arguments. */
export function interpret(record: RecordLike, packet: Packet, role: Role, history: DispatchHistory): ResultDecision {
	if (record.pendingQuestion !== undefined) return { kind: "question", text: record.pendingQuestion };
	const missing = missingReason(record, role);
	if (missing !== undefined) return retryOrBlock(missing, history);
	const result = record.structuredResult as SubagentResult;
	const omitted = result.status === "NEEDS_CONTEXT" ? [] : missingSources(result, packet);
	if (omitted.length > 0) {
		if (history.returns < MISSING_SOURCE_RETURNS) return { kind: "return", missing: omitted };
		return { kind: "blocked", reason: `the result still omits required sources: ${omitted.join(", ")}` };
	}
	return statusDecision(result, history);
}
