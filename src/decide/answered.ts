// Ledger decisions never stand in for a human: a `source: human` record counts only when the own forge
// `answer` comment of its request exists and says the same thing (ledger-store "Ledger ref and layout").

import { ANSWER_KIND } from "../interaction/approver.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { DecisionRecord } from "./records.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The valid own forge `answer` comment of request `requestId`: its `answer` object. */
function forgeAnswer(marked: MarkedComment[], requestId: string): Record<string, unknown> | undefined {
	for (const m of marked) {
		if (m.source !== "forge" || m.kind !== ANSWER_KIND || m.id !== requestId || !isObject(m.data)) continue;
		if (m.data.verdict === "valid" && isObject(m.data.answer)) return m.data.answer;
	}
	return undefined;
}

/** True when a valid own forge `answer` comment exists for the request. */
export function hasForgeAnswer(marked: MarkedComment[], requestId: string): boolean {
	return forgeAnswer(marked, requestId) !== undefined;
}

/**
 * True unless `m` is a ledger `decision` of a human (`source: human`): that one counts only when its request has an
 * own forge `answer` comment with the same outcome. Forge comments and rule, agent and reviewer records are unaffected.
 */
export function isBacked(marked: MarkedComment[], m: MarkedComment, record: DecisionRecord): boolean {
	if (m.source !== "ledger" || record.source !== "human") return true;
	if (record.request === undefined) return false;
	const answer = forgeAnswer(marked, record.request);
	if (answer === undefined) return false;
	const chosen = answer.outcome !== "dismissed" && typeof answer.choice === "string";
	return record.outcome === (chosen ? answer.choice : null);
}
