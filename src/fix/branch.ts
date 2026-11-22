// Fix branches (small-fix-lane "Fix branch"): `fix/<kebab slug>`, identified by the branch name only.

import { isKebabName } from "../core/names.ts";
import type { ProjectConfig } from "../config.ts";
import { type Git, integrationBranch } from "../engine/git.ts";

const PREFIX = "fix/";
export const DIRTY_TREE_REFUSAL = "the working tree has uncommitted changes; commit or stash them, then rerun.";
const NO_INTEGRATION = "the integration branch is unknown: origin/HEAD is not set. Set integrationBranch in .pi/livespec/config.yaml.";
const REMOTE = "origin";

/** The fix branch of `slug`. */
export const fixBranchName = (slug: string): string => `${PREFIX}${slug}`;

/** The integration branch a fix starts from and ships to, or the one refusal when it is unknown. */
export async function fixIntegration(project: ProjectConfig | null, git: Git): Promise<string | { refused: string }> {
	const integration = project ? await integrationBranch(project, git) : undefined;
	return integration ?? { refused: NO_INTEGRATION };
}

/** The local `origin/<integration>` tip (no fetch), or undefined when the ref is missing. */
export const fixIntegrationTip = (git: Git, integration: string): Promise<string | undefined> => git.remoteRef(`${REMOTE}/${integration}`);

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
