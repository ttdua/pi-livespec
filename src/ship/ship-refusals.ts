// The pure decisions of `change_ship` (ship-phase "Ship tool"): the local refusals, the pull request to open or
// adopt, and the id of the `stale` comment a freshness refusal writes.

import type { ChangeState } from "../engine/state-types.ts";
import type { PullRequest } from "../forge/types.ts";
import type { ShipStaleness } from "./freshness.ts";
import { filesOutsideUnits } from "./diff.ts";
import { SHIP_PHASE } from "./phase.ts";

/** Marker ids allow only `[A-Za-z0-9._-]`, so the timestamp drops its colons. */
const ID_UNSAFE = /[^A-Za-z0-9.-]/g;

/** The change is in `ship`; undefined when it is. */
export function shipPhaseRefusal(state: ChangeState, tool: string): string | undefined {
	const phase = state.phase.kind === "ok" ? state.phase.id : undefined;
	if (phase === SHIP_PHASE) return undefined;
	const unreviewed = phase === "review" && state.ship?.gatesAtHead?.review === false ? ` HEAD ${state.git.head.slice(0, 7)} is not covered by a passed review gate: run the review gate first.` : "";
	return `the change is in ${phase ?? "no phase"}; ${tool} runs in ${SHIP_PHASE}.${unreviewed}`;
}

/** Clean tree and current branch = the issue's `Branch` line; undefined when both hold. */
export function cleanBranchRefusal(state: ChangeState): string | undefined {
	const { branch } = state.change.header;
	if (state.git.dirty) return "the working tree is not clean: commit or stash the changes first.";
	if (branch === undefined) return "the issue has no Branch line: run change_start first.";
	if (branch !== state.git.branch) return `the current branch is ${state.git.branch}, but the issue's Branch line is ${branch}: switch to ${branch} first.`;
	return undefined;
}

/** Every file of the change diff is in some unit's `Files` or under `specs/`; undefined when so. */
export function filesRefusal(files: string[], units: ChangeState["change"]["units"]): string | undefined {
	const outside = filesOutsideUnits(files, units);
	if (outside.length === 0) return undefined;
	return `the change diff touches files no unit lists and not under specs/: ${outside.join(", ")}; add them to a unit's Files with unit_amend.`;
}

/** Phase, no `PR` line, clean tree, current branch = `Branch` line; undefined when all hold. */
export function shipLocalRefusal(state: ChangeState): string | undefined {
	const phase = shipPhaseRefusal(state, "change_ship");
	if (phase !== undefined) return phase;
	const { pr } = state.change.header;
	if (pr !== undefined) return `the issue already records PR: ${pr}; update that pull request with change_push.`;
	return cleanBranchRefusal(state);
}

export type PullRequestChoice = { kind: "open" } | { kind: "adopt"; pr: PullRequest } | { kind: "refused"; reason: string };

/**
 * The open pull requests from the change branch decide: none → open one; only ones the current account opened
 * with `Refs #<change>` → adopt the first; any other → refuse naming it.
 */
export function pullRequestChoice(open: PullRequest[], o: { login: string; change: number }): PullRequestChoice {
	const refs = new RegExp(`\\bRefs #${o.change}\\b`);
	const foreign = open.find((p) => p.author !== o.login || !refs.test(p.body));
	if (foreign !== undefined) {
		return { kind: "refused", reason: `the pull request #${foreign.number} by ${foreign.author} is already open from ${foreign.head}; close it or ship it by hand.` };
	}
	const own = open[0];
	return own === undefined ? { kind: "open" } : { kind: "adopt", pr: own };
}

/**
 * `stale.ship.<ship gate comment>.<comment id>-<updatedAt>` for a human comment, `stale.ship.<ship gate comment>.digest.<gate digest>`
 * for a body edit: a new ship approval has a new gate comment, so a repeated staleness is a new `stale` comment.
 */
export function staleShipId(staleness: Exclude<ShipStaleness, { kind: "missing" }>, gateCommentId: string): string {
	const prefix = `stale.ship.${gateCommentId.replace(ID_UNSAFE, "")}`;
	if (staleness.kind === "digest") return `${prefix}.digest.${staleness.digest}`;
	return `${prefix}.${staleness.comment.id}-${staleness.comment.updatedAt.replace(ID_UNSAFE, "")}`;
}
