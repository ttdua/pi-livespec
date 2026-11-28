// Builders of marked `dispatch` and `finding-summary` comments for tests of the build loop, gate payload and card.

import type { LedgerKind } from "../../src/core/record-kinds.ts";
import { type MarkedComment, parseMarked, writeMarked } from "../../src/forge/markers.ts";
import type { AppendInput } from "../../src/ledger/entry.ts";
import { ledgerRecord } from "../helpers/ledger.ts";
import { dispatchComment, type FindingSummaryData, findingSummaryComment, rebuttalComment } from "../../src/subagents/records.ts";
import type { Finding } from "../../src/subagents/roles.ts";

let counter = 0;

/** A marked comment from a forge body, or a ledger record from the input of a ledger kind. */
export function mark(body: string | AppendInput): MarkedComment {
	if (typeof body !== "string") return ledgerRecord(body as AppendInput & { kind: LedgerKind });
	const parsed = parseMarked(body);
	if (!parsed) throw new Error("not a marked comment");
	return { source: "forge", ref: `c${++counter}`, kind: parsed.kind, id: parsed.id, author: "me", data: parsed.data };
}

/** A placeholder own comment, so the next records sit after a `unit-start` at index 0. */
export const pad = (): MarkedComment => mark(writeMarked("counter", "pad", {}));

export const finding = (over: Partial<Finding> = {}): Finding => ({
	severity: "WARNING", kind: "defect", location: "a.ts:1", evidence: "the cap is off by one", fix: "use >=", scope: "unit", ...over,
});

export function implemented(unit: string, over: Record<string, unknown> = {}): MarkedComment {
	return mark(dispatchComment({
		role: "implementer", unit, attempt: 1, packet: "p", agentSource: "s", requested: { thinking: "low" }, effective: {},
		status: "DONE", commits: ["a"], notes: "n", discoveries: [], sources_used: [], ...over,
	}));
}

export function reviewed(over: Partial<FindingSummaryData> = {}): MarkedComment {
	return mark(findingSummaryComment({
		role: "reviewer", subject: "unit", unit: "U3", round: 1, status: "DONE", advisory: false, head: "f".repeat(40), packet: "p",
		sources_used: [], required: [], completed: true, agentSource: "s", requested: { thinking: "low" }, effective: {}, findings: [], ...over,
	}));
}

export function rebutted(comment: string, index: number, reason: string, evidence: string): MarkedComment {
	return mark(rebuttalComment({ rebuts: comment, items: [{ index, reason, evidence }] }));
}
