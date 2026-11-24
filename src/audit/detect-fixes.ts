// The `declared-none` detector: fix pull requests that declared no behavior
// change for a capability. Forge read errors propagate to the caller.

import { parseDecisionBlocks } from "../decide/records.ts";
import type { Forge, PullRequest } from "../forge/types.ts";
import { type DriftItem, driftItem, pullRequestOf } from "./items.ts";

export type FixCommit = { sha: string; subject: string };

const FIX_HEAD = "fix/";
const SHORT_SHA = 12;

/** One item per capability a merged `fix/*` pull request declared `behavior_change: declared-none` for. */
export async function detectFixes(commits: FixCommit[], forge: Pick<Forge, "getPullRequest">): Promise<DriftItem[]> {
	const items = new Map<string, DriftItem>();
	for (const commit of commits) {
		const n = pullRequestOf(commit.subject);
		if (n === undefined) continue;
		const pr = await forge.getPullRequest(n);
		if (!pr.head.startsWith(FIX_HEAD)) continue;
		for (const capability of declaredNone(pr)) {
			const evidence = `pull request #${n} (${pr.head}, commit ${commit.sha.slice(0, SHORT_SHA)}) declared no behavior change for ${capability}`;
			const item = driftItem("declared-none", `pr#${n}:${capability}`, evidence, capability);
			if (!items.has(item.key)) items.set(item.key, item);
		}
	}
	return [...items.values()];
}

/** The capabilities of the pull request's last `lane` block when it has `behavior_change: declared-none`. */
function declaredNone(pr: PullRequest): string[] {
	const lane = parseDecisionBlocks(pr.body).filter((r) => r.point === "lane").at(-1);
	const outcome = lane?.outcome;
	if (typeof outcome !== "object" || outcome === null) return [];
	const { behavior_change, capabilities } = outcome as { behavior_change?: unknown; capabilities?: unknown };
	if (behavior_change !== "declared-none" || !Array.isArray(capabilities)) return [];
	return capabilities.filter((c): c is string => typeof c === "string" && c !== "");
}
