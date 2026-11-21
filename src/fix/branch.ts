// Fix branches (small-fix-lane "Fix branch"): `fix/<kebab slug>`, identified by the branch name only.

import { isKebabName } from "../core/names.ts";
import type { Git } from "../engine/git.ts";

const PREFIX = "fix/";
export const DIRTY_TREE_REFUSAL = "the working tree has uncommitted changes; commit or stash them, then rerun.";
const REMOTE = "origin";

/** The slug of a fix branch `fix/<slug>`, or undefined when the branch is not one. */
export function fixSlug(branch: string): string | undefined {
	if (!branch.startsWith(PREFIX)) return undefined;
	const slug = branch.slice(PREFIX.length);
	return isKebabName(slug) ? slug : undefined;
}

/** Fetches `origin <integration>` and returns the merge base of HEAD and `origin/<integration>`; throws on any git failure (no fallback). */
export async function fixMergeBase(git: Git, integration: string): Promise<string> {
	await git.fetch(REMOTE, integration);
	return git.mergeBase("HEAD", `${REMOTE}/${integration}`);
}

/** The merge base with `origin/<integration>` (after a fetch) and the commit subjects after it, oldest first; throws on any git failure. */
export async function fixRange(git: Git, integration: string): Promise<{ mergeBase: string; subjects: string[] }> {
	const mergeBase = await fixMergeBase(git, integration);
	return { mergeBase, subjects: await git.subjects(mergeBase, "HEAD") };
}
