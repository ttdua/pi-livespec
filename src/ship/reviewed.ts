// Reviewed HEAD (design D3): the latest non-staled approved review gate's SHA, and the clean-merge exception.

import type { Git } from "../engine/git.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { validApproval } from "../engine/locks.ts";

export type ReviewedResult = { ok: true } | { ok: false; reason: string };

/** The `head_sha` of the valid approved `review` gate result; no comparison with HEAD. */
export function reviewedHead(state: ChangeState): string | undefined {
	const gate = state.lock.gates.review;
	return validApproval(gate) ? gate?.headSha : undefined;
}

type Step = { ok: true } | { ok: false; reason: string } | "unsupported";

/** One first-parent commit must be a clean merge `prev + p2` with `p2` from the integration branch. */
async function checkMerge(git: Git, commit: string, prev: string, integrationTip: string): Promise<Step> {
	const parents = await git.parents(commit);
	const short = commit.slice(0, 7);
	if (parents.length !== 2 || parents[0] !== prev) return { ok: false, reason: `commit ${short} after the review is not a merge of the integration branch` };
	const second = parents[1] as string;
	if (!(await git.isAncestor(second, integrationTip))) return { ok: false, reason: `merge ${short} brings a commit that is not on the integration branch` };
	const predicted = await git.mergeTree(prev, second);
	if (predicted === "unsupported") return "unsupported";
	if (predicted === "conflict") return { ok: false, reason: `merge ${short} had conflicts resolved by hand` };
	if (predicted.tree !== (await git.treeOf(commit))) return { ok: false, reason: `merge ${short} was edited after it was made` };
	return { ok: true };
}

const noReview = (): ReviewedResult => ({ ok: false, reason: "the review gate has no approved result at a known commit; run the review gate first" });
const unsupported = (head: string, reviewed: string): ReviewedResult => ({
	ok: false,
	reason: `HEAD ${head.slice(0, 7)} differs from the reviewed ${reviewed.slice(0, 7)} and this git is too old for merge-tree --write-tree (needs 2.38), so only equality counts`,
});

export async function isReviewed(git: Git, reviewed: string | undefined, head: string, integrationTip: string): Promise<ReviewedResult> {
	if (reviewed === undefined) return noReview();
	if (reviewed === head) return { ok: true };
	let prev = reviewed;
	for (const commit of await git.firstParentList(`${reviewed}..${head}`)) {
		const step = await checkMerge(git, commit, prev, integrationTip);
		if (step === "unsupported") return unsupported(head, reviewed);
		if (!step.ok) return { ok: false, reason: `${step.reason} (reviewed ${reviewed.slice(0, 7)}, HEAD ${head.slice(0, 7)})` };
		prev = commit;
	}
	return { ok: true };
}
