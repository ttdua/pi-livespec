// The behavior items of a define gate request: stored in `GateSnapshot.behavior` at request time and
// read back, never recomputed, by the adapters (`overridableBehavior`), forge matching and completion.

import type { BehaviorItem } from "../docs/behavior-change.ts";
import { effectiveConclusion } from "../docs/behavior-change.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { ApprovalRequest, GateSnapshot } from "./approver.ts";

/** The snapshot field for `items`, each with its effective outcome now; `undefined` without items. */
export function behaviorSnapshot(items: BehaviorItem[] | undefined, marked: MarkedComment[]): GateSnapshot["behavior"] {
	if (items === undefined || items.length === 0) return undefined;
	return items.map((item) => ({ capability: item.capability, files: item.files, outcome: effectiveConclusion(marked, item)?.outcome ?? null }));
}

/** What the in-session adapters offer to override, derived from the stored snapshot. */
export function overridableBehaviorOf(behavior: GateSnapshot["behavior"]): ApprovalRequest["overridableBehavior"] {
	if (behavior === undefined || behavior.length === 0) return undefined;
	return { items: behavior.map((i) => ({ capability: i.capability, outcome: i.outcome })) };
}
