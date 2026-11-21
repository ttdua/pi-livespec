// The tag re-check of a review round (design D10): the `tags` rule over the diff's files, minus the units' tags.

import { ruleFor } from "../decide/registry.ts";
import type { TagsFacts } from "../decide/rules/tags.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";

/**
 * Tags the `tags` rule gives the diff's files that no unit carries. The rule never asks, so it is called
 * synchronously through the registry; the stage records the result as `decision` `tags.review`.
 */
export function retag(pack: Pack, state: ChangeState, diffFiles: string[]): string[] {
	const rule = ruleFor("tags");
	if (rule === undefined) throw new Error("no rule is registered for decision point `tags`");
	const facts: TagsFacts = { files: diffFiles, title: "", covers: [], doneMeans: [], extraTags: [] };
	const result = rule.fn(facts, pack.decisions.tags);
	if (!("outcome" in result) || !Array.isArray(result.outcome)) throw new Error("the tags rule asked or gave no tag list");
	const carried = new Set(state.change.units.flatMap((u) => u.tags ?? []));
	return (result.outcome as string[]).filter((t) => !carried.has(t));
}
