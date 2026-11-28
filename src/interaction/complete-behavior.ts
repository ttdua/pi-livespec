// Human behavior overrides at a define gate answered `changes_requested` (design D7): one `human`
// `changed` conclusion per override. The items come from the stored request snapshot, so completion
// does no I/O to recompute them. Idempotent by `overridden_by.by/at`.

import type { DecisionRecord } from "../decide/records.ts";
import { BEHAVIOR_POINT, behaviorConclusionComment } from "../docs/behavior-change.ts";
import type { Answered, BehaviorOverride, GateSnapshot } from "./approver.ts";
import { postComment, type Run } from "./complete-effects.ts";

type SnapshotItem = NonNullable<GateSnapshot["behavior"]>[number];

/** Whether this answer's record for `capability` exists. */
function hasRecord(run: Run, capability: string, answer: Answered): boolean {
	return run.marked.some((m) => {
		const by = (m.data as Partial<DecisionRecord> | null)?.overridden_by;
		return m.kind === "decision" && m.id === `${BEHAVIOR_POINT}.${capability}` && by?.by === answer.by && by.at === answer.at;
	});
}

async function record(run: Run, item: SnapshotItem, override: BehaviorOverride, answer: Answered): Promise<void> {
	await postComment(
		run,
		behaviorConclusionComment(
			{ capability: item.capability, files: item.files },
			{ source: "human", outcome: override.outcome, reason: `set by ${answer.by} at the gate`, overridden_by: { by: answer.by, at: answer.at, from: item.outcome } },
		),
	);
}

/** Posts a human `changed` record for each override whose capability is an item of `snapshot` and not yet recorded. */
export async function applyBehaviorOverrides(run: Run, answer: Answered, snapshot: GateSnapshot): Promise<void> {
	for (const override of answer.behaviorOverrides ?? []) {
		const item = snapshot.behavior?.find((i) => i.capability === override.capability);
		if (item === undefined || hasRecord(run, item.capability, answer)) continue;
		await record(run, item, override, answer);
	}
}
