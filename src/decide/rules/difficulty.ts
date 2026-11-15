// The `difficulty` rule: low, medium or high from tags, capabilities and file count.

import type { RuleResult, RuleSchema } from "../registry.ts";
import { isMap } from "yaml";
import { checkAllowedKeys } from "./schema-util.ts";

export type Difficulty = "low" | "medium" | "high";
export type DifficultyFacts = { tags: string[]; covers: string[]; files: string[] };

export const difficultySchema: RuleSchema = {
	validate(node, report) {
		if (isMap(node)) checkAllowedKeys(node, ["mode"], "decisions.difficulty", report);
	},
};

const HIGH_TAGS = ["security", "migration"];
const MAX_FILES = 4;

/** The capability of a `Covers` entry: the part before the first `/`. */
function capabilityOf(cover: string): string {
	const slash = cover.indexOf("/");
	return (slash === -1 ? cover : cover.slice(0, slash)).trim();
}

/** `high` on a high tag, more than one capability or more than 4 files; `low` on one file and no tags; else `medium`. */
export function difficultyRule(facts: unknown, _config: unknown): RuleResult {
	const f = facts as DifficultyFacts;
	const highTags = f.tags.filter((t) => HIGH_TAGS.includes(t));
	const capabilities = [...new Set(f.covers.map(capabilityOf))];
	const counts = `${f.files.length} file${f.files.length === 1 ? "" : "s"}, tags [${f.tags.join(", ")}], capabilities [${capabilities.join(", ")}]`;
	const result = (outcome: Difficulty, why: string): RuleResult => ({ outcome, reason: `${why} (${counts})` });
	if (highTags.length > 0) return result("high", `tag ${highTags.join(", ")}`);
	if (capabilities.length > 1) return result("high", "covers more than one capability");
	if (f.files.length > MAX_FILES) return result("high", `more than ${MAX_FILES} files`);
	if (f.files.length === 1 && f.tags.length === 0) return result("low", "one file and no tags");
	return result("medium", "default");
}
