// Records the agent's `behavior` conclusions at `spec_gate define|review` (durable-doc-checks "Behavior conclusion
// at the gate"): the list must cover every behavior item and no other capability; each conclusion that differs from
// the latest agent record at the same digest is appended to the ledger. Nothing is written when the coverage refusal,
// the refusal for a legacy `decide:behavior-change` request still open for an item, or the refusal of a disputed
// conclusion restated (durable-doc-checks "Disputed conclusion not restated") applies.

import { validDecisionEntries } from "../decide/records.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { WriteContext } from "../tools/guard.ts";
import { appendRecord } from "../tools/subagent-request.ts";
import { BEHAVIOR_POINT, type BehaviorConclusionInput, type BehaviorItem, behaviorConclusionComment, behaviorDigest, legacyRequestRefusal } from "./behavior-change.ts";
import { changeBehaviorItems } from "./behavior-check.ts";
import { mentions } from "./readers.ts";

export type BehaviorRecordResult = { ok: true; posted: boolean } | { ok: false; message: string };

/** The coverage refusal, or undefined when `entries` list exactly the items' capabilities. */
function coverageRefusal(items: BehaviorItem[], entries: BehaviorConclusionInput[]): string | undefined {
	const wanted = new Set(items.map((i) => i.capability));
	const given = new Set(entries.map((e) => e.capability));
	const missing = [...wanted].filter((c) => !given.has(c));
	const extra = [...given].filter((c) => !wanted.has(c));
	if (missing.length === 0 && extra.length === 0) return undefined;
	const parts = [missing.length > 0 ? `missing ${missing.join(", ")}` : "", extra.length > 0 ? `not a behavior item ${extra.join(", ")}` : ""].filter((p) => p !== "");
	return `spec_gate refused: behavior must conclude every capability whose code changed without its spec: ${parts.join("; ")}. Pass behavior: [{ capability, outcome: unchanged|changed, rationale }]; nothing was written.`;
}

/** The agent reasons for `capability` recorded before `index` in `state.marked`. */
function earlierAgentReasons(state: ChangeState, capability: string, index: number): Set<string> {
	const reasons = new Set<string>();
	for (const [i, m] of state.marked.entries()) {
		if (i >= index) break;
		const r = validDecisionEntries([m])[0]?.record;
		if (r !== undefined && r.point === BEHAVIOR_POINT && r.subject === capability && r.source === "agent") reasons.add(r.reason);
	}
	return reasons;
}

/**
 * The refusal of an `unchanged` conclusion that restates an earlier agent rationale for a capability the notes of
 * the valid, non-superseded `changes_requested` define gate result name; undefined otherwise.
 */
function disputeRefusal(state: ChangeState, items: BehaviorItem[], entries: BehaviorConclusionInput[]): string | undefined {
	const gate = state.lock.gates.define;
	if (gate === undefined || gate.outcome !== "changes_requested" || gate.superseded) return undefined;
	const at = state.marked.findIndex((m) => m.ref === gate.commentId);
	if (at < 0) return undefined;
	for (const item of items) {
		const entry = entries.find((e) => e.capability === item.capability);
		if (entry?.outcome !== "unchanged" || !mentions(gate.notes, item.capability)) continue;
		if (earlierAgentReasons(state, item.capability, at).has(entry.rationale)) {
			return `spec_gate refused: the define gate requested changes naming ${item.capability}, and behavior restates its earlier unchanged rationale. Conclude ${item.capability} changed, or give a new rationale that answers the notes; nothing was written.`;
		}
	}
	return undefined;
}

/** True when the latest agent record of the item at its digest already says this outcome and reason. */
function alreadyRecorded(state: ChangeState, item: BehaviorItem, e: BehaviorConclusionInput): boolean {
	const digest = behaviorDigest(item.files);
	const same = validDecisionEntries(state.marked).filter(({ record: r }) => r.point === BEHAVIOR_POINT && r.subject === item.capability && r.source === "agent" && r.digest === digest);
	const latest = same.at(-1)?.record;
	return latest !== undefined && latest.outcome === e.outcome && latest.reason === e.rationale;
}

/** Appends one agent `decision` per conclusion not already recorded; `posted` says whether anything was written. */
export async function recordBehaviorConclusions(w: WriteContext, state: ChangeState, entries: BehaviorConclusionInput[]): Promise<BehaviorRecordResult> {
	const items = await changeBehaviorItems(w.session.cwd, w.session.git, state.change.header.base);
	const refusal = legacyRequestRefusal(items, state.marked) ?? coverageRefusal(items, entries) ?? disputeRefusal(state, items, entries);
	if (refusal !== undefined) return { ok: false, message: refusal };
	let posted = false;
	for (const item of items) {
		const entry = entries.find((e) => e.capability === item.capability);
		if (entry === undefined || alreadyRecorded(state, item, entry)) continue;
		await appendRecord(w, state.issue.number, behaviorConclusionComment(item, { outcome: entry.outcome, reason: entry.rationale }));
		posted = true;
	}
	return { ok: true, posted };
}
