// Records a reviewer's `behavior` conclusions (durable-doc-checks "Reviewer behavior conclusion"): after the
// `finding-summary` of a completed, non-advisory `change` run, one `reviewer` decision per entry whose outcome
// differs from the effective conclusion the packet showed. Kept out of `run-record.ts`, which `subagents/` owns.
// The summary stores the cleaned entries, so a record lost to a failed write is replayed from it (idempotent).

import { validDecisions } from "../decide/records.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { AppendInput } from "../ledger/entry.ts";
import { computeCompleted, type FindingSummaryData } from "../subagents/records.ts";
import type { ReviewerBehavior, SubagentResult } from "../subagents/roles.ts";
import type { RunFacts } from "../subagents/run-record.ts";
import type { Packet } from "../subagents/source-types.ts";
import { BEHAVIOR_POINT, behaviorConclusionComment, behaviorDigest } from "./behavior-change.ts";
import { entryOf } from "./behavior-param.ts";

type Append = (input: AppendInput) => Promise<void>;
type Recorded = { capability: string; digest: string; outcome: string };

const isChangeReview = (run: Pick<RunFacts, "role" | "subject" | "advisory">): boolean => run.role === "reviewer" && run.subject === "change" && !run.advisory;

/**
 * The result with its `behavior` entries made safe to store: each goes through the `spec_gate` entry check (one line,
 * at most 300 code points on the raw text, then neutralised). An invalid or repeated capability is dropped and named
 * in `notes`; the first valid entry wins. Runs once per result, before the dispute check; recording never re-runs it.
 */
export function cleanReviewerBehavior(run: RunFacts, result: SubagentResult): SubagentResult {
	if (!isChangeReview(run) || result.behavior === undefined) return result;
	const kept: ReviewerBehavior[] = [];
	const dropped: string[] = [];
	for (const [i, raw] of result.behavior.entries()) {
		const checked = entryOf(raw, i);
		if ("refusal" in checked) dropped.push(checked.refusal);
		else if (kept.some((e) => e.capability === checked.entry.capability)) dropped.push(`behavior[${i}].capability ${checked.entry.capability} is listed twice`);
		else kept.push(checked.entry);
	}
	const note = dropped.length === 0 ? "" : `Dropped behavior entries: ${dropped.join("; ")}.`;
	return { ...result, behavior: kept, ...(note === "" ? {} : { notes: result.notes === "" ? note : `${result.notes}\n${note}` }) };
}

/** Appends one `reviewer` record per entry that differs from the packet's effective conclusion and is not in `recorded`. */
async function postConclusions(record: Append, entries: ReviewerBehavior[], behavior: NonNullable<Packet["behavior"]>, recorded: Recorded[]): Promise<number> {
	let posted = 0;
	for (const entry of entries) {
		const item = behavior.items.find((i) => i.capability === entry.capability);
		if (item === undefined || behavior.effective[item.capability]?.outcome === entry.outcome) continue;
		const digest = behaviorDigest(item.files);
		if (recorded.some((r) => r.capability === item.capability && r.digest === digest && r.outcome === entry.outcome)) continue;
		await record(behaviorConclusionComment(item, { source: "reviewer", outcome: entry.outcome, reason: entry.rationale }));
		posted++;
	}
	return posted;
}

/** Appends the reviewer's conclusions of an already-cleaned result; unknown capabilities are ignored. */
export async function recordReviewerConclusions(record: Append, run: RunFacts, result: SubagentResult, packet: Packet): Promise<void> {
	const required = packet.sources.filter((s) => s.required).map((s) => s.id);
	if (packet.behavior === undefined || !isChangeReview(run) || !computeCompleted(result, required)) return;
	await postConclusions(record, result.behavior ?? [], packet.behavior, []);
}

/** `reviewer` behavior records after merged position `at`. */
function recordedAfter(marked: MarkedComment[], at: number): Recorded[] {
	return validDecisions(marked.slice(at + 1))
		.filter((r) => r.point === BEHAVIOR_POINT && r.source === "reviewer")
		.map((r) => ({ capability: r.subject, digest: r.digest ?? "", outcome: String(r.outcome) }));
}

/**
 * Re-appends the reviewer records of a completed `change` summary that a failed write lost: entries stored on the
 * summary, minus those already recorded after it (by merged position) for the same capability, digest and outcome.
 * Returns the count appended.
 */
export async function replayReviewerConclusions(record: Append, marked: MarkedComment[], summary: { commentId: string; data: FindingSummaryData }, packet: Packet | undefined): Promise<number> {
	const { data } = summary;
	if (packet?.behavior === undefined || !data.completed || !isChangeReview(data) || data.behavior === undefined) return 0;
	const at = marked.findIndex((m) => m.ref === summary.commentId);
	if (at < 0) return 0;
	return postConclusions(record, data.behavior, packet.behavior, recordedAfter(marked, at));
}
