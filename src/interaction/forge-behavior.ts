// Forge `set behavior` overrides (design D7): collected per request while it is pending, attached only to a
// `changes_requested` answer. Items are read from the stored request snapshot, never recomputed.

import type { Answered, BehaviorOverride, GateSnapshot } from "./approver.ts";
import type { PendingRequest } from "./requests.ts";

/** Request id → capability → override, kept for one matching pass. */
export type BehaviorStore = Map<string, Map<string, BehaviorOverride>>;

const DEFINE_SUBJECT = "gate:define";

/** Why `capability` cannot be set on `request`, or `undefined` when it can. */
export function behaviorRefusal(request: PendingRequest, capability: string): string | undefined {
	if (request.subject !== DEFINE_SUBJECT) return `behavior can be set only on the define gate, not ${request.subject}`;
	const items = (request.data.snapshot as Partial<GateSnapshot>).behavior ?? [];
	return items.some((i) => i.capability === capability) ? undefined : `${capability} is not a behavior item of ${request.subject}, so it cannot be set`;
}

/** Collects `capability` for `request`; the caller checked `behaviorRefusal`. */
export function collectBehavior(store: BehaviorStore, request: PendingRequest, capability: string): void {
	const byCapability = store.get(request.id) ?? new Map<string, BehaviorOverride>();
	byCapability.set(capability, { capability, outcome: "changed" });
	store.set(request.id, byCapability);
}

/** `answer` with the collected overrides when it requests changes; `discarded` when it does not and some were collected. */
export function attachBehavior(store: BehaviorStore, request: PendingRequest, answer: Answered): { answer: Answered; discarded: boolean } {
	const collected = store.get(request.id);
	if (collected === undefined || collected.size === 0) return { answer, discarded: false };
	if (answer.outcome !== "changes_requested") return { answer, discarded: true };
	return { answer: { ...answer, behaviorOverrides: [...collected.values()] }, discarded: false };
}

export const BEHAVIOR_DISCARDED = "behavior overrides apply only with /livespec changes; ignored";
