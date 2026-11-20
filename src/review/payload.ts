// The review result at the `ship` gate (finding-routing "Review result at the ship gate"): registered as a gate payload.

import type { ReviewFacts } from "../engine/gate-payload.ts";
import { registerGatePayload } from "../engine/gates.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { type AggregateFinding, current, type FindingSummaryData, rebuttedKeys, findingKey } from "../subagents/records.ts";
import { INLINE_SOURCE } from "../subagents/run-record.ts";
import { aggregateOf, latestRun, type ReviewRunData, verifierRecord } from "./records.ts";
import { findingState } from "./status.ts";

const SHIP_PHASE = "ship";

const describe = (f: AggregateFinding): string => `${f.severity} ${f.kind} at ${untrusted(f.location)}: ${untrusted(f.evidence)}`;

/** Subjects of the round whose completed reviewer run at the round's HEAD was recorded inline. */
function inlineSubjects(marked: MarkedComment[], run: ReviewRunData): string[] {
	const inline = new Set(
		current(marked).flatMap((m) => {
			const d = m.data as FindingSummaryData;
			const ok = m.kind === "finding-summary" && d.role === "reviewer" && d.unit === undefined && d.aggregate !== true && d.head === run.head && d.agentSource === INLINE_SOURCE;
			return ok ? [d.subject as string] : [];
		}),
	);
	return run.selected.filter((s) => inline.has(s));
}

/** The lines of one aggregate: disputed, rebutted and out-of-scope findings, each with its key's facts. */
function findingLines(state: ChangeState, commentId: string, findings: AggregateFinding[]): string[] {
	const rebutted = rebuttedKeys(state.marked);
	const lines: string[] = [];
	findings.forEach((f, i) => {
		const key = findingKey(commentId, i);
		const status = findingState(state.marked, commentId, i, state.change.questions);
		if (status === "disputed") lines.push(`- Disputed: ${describe(f)} (verifier: ${untrusted(verifierRecord(state.marked, key)?.reason ?? "no reason recorded")})`);
		else if (rebutted.has(key) && f.kind !== "missed-context") lines.push(`- Rebutted: ${describe(f)}`);
		if (f.route === "out-of-scope" && status !== "disputed") lines.push(`- Follow-up: ${describe(f)}`);
	});
	return lines;
}

/** The ship payload section: the latest routed round's number, HEAD and findings of interest; undefined without one. */
export function reviewPayload(state: ChangeState, _facts: ReviewFacts): string | undefined {
	const run = latestRun(state.marked);
	if (run === undefined || !run.routed) return undefined;
	const aggregate = aggregateOf(state.marked, run.round);
	if (aggregate === undefined) return undefined;
	const lines = findingLines(state, aggregate.commentId, aggregate.data.findings as AggregateFinding[]);
	const inline = inlineSubjects(state.marked, run);
	return [
		`Review round ${run.round} at ${run.head}:`,
		...(lines.length === 0 ? ["- No disputed, rebutted or out-of-scope findings."] : lines),
		...(inline.length === 0 ? [] : [`Inline reviews: ${inline.join(", ")}`]),
	].join("\n");
}

export function registerReviewPayload(): void {
	registerGatePayload(SHIP_PHASE, reviewPayload);
}
