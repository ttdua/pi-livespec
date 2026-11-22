// Resolves the change of the current branch at session start: the open
// `livespec` issue whose `Branch:` line equals the branch, else the issue whose
// title equals `<name>` of `livespec/<name>` (with a warning). Otherwise the
// open changes are listed for the card.

import { parseChange } from "../core/change.ts";
import { LABEL_LIVESPEC } from "../forge/labels.ts";
import type { Forge, Issue } from "../forge/types.ts";
import { phaseFromLabels } from "./snapshot.ts";

/** `readiness` is filled at refresh by a registered list hook: all dependencies merged, the unmerged ones, or parked. */
export type OpenChange = { number: number; title: string; phase?: string; readiness?: "ready" | { waits: number[] } | "parked" };

export type ResolvedChange =
	| { kind: "change"; number: number; warning?: string }
	| { kind: "none"; open: OpenChange[] }
	| { kind: "error"; message: string };

export const OPEN_CHANGES_CAP = 10;
export const CHANGE_BRANCH_PREFIX = "livespec/";

function toOpenChange(issue: Issue): OpenChange {
	const phase = phaseFromLabels(issue.labels);
	return phase.kind === "ok" ? { number: issue.number, title: issue.title, phase: phase.id } : { number: issue.number, title: issue.title };
}

function severalMatches(branch: string, matches: Issue[]): ResolvedChange {
	const numbers = matches.map((i) => `#${i.number}`).join(", ");
	return { kind: "error", message: `Several open changes match ${branch}: ${numbers}. Keep the Branch: line on one issue only.` };
}

/** One match resolves, several is an error, none defers to the next rule. */
function single(branch: string, matches: Issue[], warning?: (n: number) => string): ResolvedChange | undefined {
	if (matches.length > 1) return severalMatches(branch, matches);
	const [only] = matches;
	if (!only) return undefined;
	return warning ? { kind: "change", number: only.number, warning: warning(only.number) } : { kind: "change", number: only.number };
}

type Candidate = { issue: Issue; branch: string | undefined };

function byBranchLine(candidates: Candidate[], branch: string): Issue[] {
	return candidates.filter((c) => c.branch === branch).map((c) => c.issue);
}

/** Only issues without a `Branch:` line: one that records another branch belongs to that branch. */
function byTitle(candidates: Candidate[], branch: string): Issue[] {
	const name = branch.slice(CHANGE_BRANCH_PREFIX.length);
	return candidates.filter((c) => c.branch === undefined && c.issue.title === name).map((c) => c.issue);
}

/** Resolves the change of a `livespec/<name>` branch: by `Branch:` line first, then by title. */
function matchChangeBranch(open: Issue[], branch: string): ResolvedChange | undefined {
	const candidates = open.map((issue) => ({ issue, branch: parseChange(issue.body).header.branch }));
	const titleWarning = (n: number) => `Change #${n} matches ${branch} by title only: its Branch: line is not recorded.`;
	return single(branch, byBranchLine(candidates, branch)) ?? single(branch, byTitle(candidates, branch), titleWarning);
}

/**
 * Only a `livespec/<name>` branch resolves to a change. On any other branch, and when nothing matches,
 * the open changes are listed in the forge's search order, capped at OPEN_CHANGES_CAP.
 */
export async function resolveChange(forge: Forge, branch: string): Promise<ResolvedChange> {
	const open = await forge.searchIssues({ labels: [LABEL_LIVESPEC], state: "open" });
	const matched = branch.startsWith(CHANGE_BRANCH_PREFIX) ? matchChangeBranch(open, branch) : undefined;
	return matched ?? { kind: "none", open: open.slice(0, OPEN_CHANGES_CAP).map(toOpenChange) };
}
