// Fix branches (small-fix-lane "Fix branch"): `fix/<kebab slug>`, identified by the branch name only.

import { isKebabName } from "../core/names.ts";
import type { Git } from "../engine/git.ts";

const PREFIX = "fix/";
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
