// Records a reviewer's `behavior` conclusions (durable-doc-checks "Reviewer behavior conclusion"): after the
// `finding-summary` of a completed, non-advisory `change` run, one `reviewer` decision per entry whose outcome
// differs from the effective conclusion the packet showed. Kept out of `run-record.ts`, which `subagents/` owns.

import { computeCompleted } from "../subagents/records.ts";
import type { SubagentResult } from "../subagents/roles.ts";
import type { RunFacts } from "../subagents/run-record.ts";
import type { Packet } from "../subagents/source-types.ts";
import { behaviorConclusionComment } from "./behavior-change.ts";
import { entryOf } from "./behavior-param.ts";

const isChangeReview = (run: RunFacts): boolean => run.role === "reviewer" && run.subject === "change" && !run.advisory;

/**
 * The result with its `behavior` entries made safe to store: each goes through the `spec_gate` entry check (one line,
 * at most 300 code points, neutralised). An invalid or repeated capability is dropped and named in `notes`; the first wins.
 */
export function cleanReviewerBehavior(run: RunFacts, result: SubagentResult): SubagentResult {
	if (!isChangeReview(run) || result.behavior === undefined) return result;
	const kept: NonNullable<SubagentResult["behavior"]> = [];
	const dropped: string[] = [];
	for (const [i, raw] of result.behavior.entries()) {
		const checked = entryOf(raw, i);
		if ("refusal" in checked) dropped.push(checked.refusal);
		else if (kept.some((e) => e.capability === checked.entry.capability)) dropped.push(`behavior[${i}].capability ${checked.entry.capability} is listed twice`);
		else kept.push(checked.entry);
	}
	if (dropped.length === 0 && kept.every((e, i) => e.rationale === result.behavior?.[i]?.rationale)) return result;
	const note = dropped.length === 0 ? "" : `Dropped behavior entries: ${dropped.join("; ")}.`;
	return { ...result, behavior: kept, ...(note === "" ? {} : { notes: result.notes === "" ? note : `${result.notes}\n${note}` }) };
}

/** Posts the reviewer's conclusions that differ from the packet's effective ones; unknown capabilities are ignored. */
export async function recordReviewerConclusions(post: (body: string) => Promise<void>, run: RunFacts, result: SubagentResult, packet: Packet): Promise<void> {
	const { behavior } = packet;
	const required = packet.sources.filter((s) => s.required).map((s) => s.id);
	if (behavior === undefined || !isChangeReview(run) || !computeCompleted(result, required)) return;
	for (const entry of cleanReviewerBehavior(run, result).behavior ?? []) {
		const item = behavior.items.find((i) => i.capability === entry.capability);
		if (item === undefined || behavior.effective[item.capability]?.outcome === entry.outcome) continue;
		await post(behaviorConclusionComment(item, { source: "reviewer", outcome: entry.outcome, reason: entry.rationale }));
	}
}
