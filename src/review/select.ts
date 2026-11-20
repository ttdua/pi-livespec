// Reviewer selection for a review round (design D9). Pure.

import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { changeFacts } from "../subagents/phase-entries.ts";
import { entriesFor, holds } from "../subagents/policy.ts";
import type { ReviewSubject } from "../subagents/roles.ts";

const REVIEW = "review";

/**
 * The `reviewer` subjects of the `review` phase that hold for the change facts, in pack order. Tags are the units'
 * plus `extraTags` (the re-checked ones); `turnsCompleted` is 0, so `context>=N%` never holds.
 */
export function selectSubjects(pack: Pack, state: ChangeState, extraTags: string[]): ReviewSubject[] {
	const base = changeFacts(state);
	const facts = { ...base, tags: [...new Set([...base.tags, ...extraTags])], turnsCompleted: 0 };
	return entriesFor(pack, REVIEW)
		.filter((e) => e.role === "reviewer" && e.subject !== undefined && (e.mode === "always" || (e.mode === "auto" && holds(e, facts))))
		.map((e) => e.subject as ReviewSubject);
}
