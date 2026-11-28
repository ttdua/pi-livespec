// Records a reviewer's `behavior` conclusions (durable-doc-checks "Reviewer behavior conclusion"): after the
// `finding-summary` of a completed, non-advisory `change` run, one `reviewer` decision per entry whose outcome
// differs from the effective conclusion the packet showed. Kept out of `run-record.ts`, which `subagents/` owns.

import { computeCompleted } from "../subagents/records.ts";
import type { SubagentResult } from "../subagents/roles.ts";
import type { RunFacts } from "../subagents/run-record.ts";
import type { Packet } from "../subagents/source-types.ts";
import { behaviorConclusionComment } from "./behavior-change.ts";

const isChangeReview = (run: RunFacts): boolean => run.role === "reviewer" && run.subject === "change" && !run.advisory;

/** Posts the reviewer's conclusions that differ from the packet's effective ones; unknown capabilities are ignored. */
export async function recordReviewerConclusions(post: (body: string) => Promise<void>, run: RunFacts, result: SubagentResult, packet: Packet): Promise<void> {
	const { behavior } = packet;
	const required = packet.sources.filter((s) => s.required).map((s) => s.id);
	if (behavior === undefined || !isChangeReview(run) || !computeCompleted(result, required)) return;
	for (const entry of result.behavior ?? []) {
		const item = behavior.items.find((i) => i.capability === entry.capability);
		if (item === undefined || behavior.effective[item.capability]?.outcome === entry.outcome) continue;
		await post(behaviorConclusionComment(item, { source: "reviewer", outcome: entry.outcome, reason: entry.rationale }));
	}
}
