// The pure decisions of `change_ship` (ship-phase "Ship tool"): the local refusals, the pull request to open or
// adopt, and the id of the `stale` comment a freshness refusal writes.

import type { ChangeState } from "../engine/state-types.ts";
import type { PullRequest } from "../forge/types.ts";
import type { ShipStaleness } from "./freshness.ts";
import { SHIP_PHASE } from "./phase.ts";

/** Marker ids allow only `[A-Za-z0-9._-]`, so the timestamp drops its colons. */
const ID_UNSAFE = /[^A-Za-z0-9.-]/g;

/** Phase, clean tree, current branch = `Branch` line and no `PR` line; undefined when all hold. */
export function shipLocalRefusal(state: ChangeState): string | undefined {
	const phase = state.phase.kind === "ok" ? state.phase.id : undefined;
	if (phase !== SHIP_PHASE) return `the change is in ${phase ?? "no phase"}; change_ship runs in ${SHIP_PHASE}.`;
	const { branch, pr } = state.change.header;
	if (pr !== undefined) return `the issue already records PR: ${pr}; update that pull request with change_push.`;
	if (state.git.dirty) return "the working tree is not clean: commit or stash the changes first.";
	if (branch === undefined) return "the issue has no Branch line: run change_start first.";
	if (branch !== state.git.branch) return `the current branch is ${state.git.branch}, but the issue's Branch line is ${branch}: switch to ${branch} first.`;
	return undefined;
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

/** `stale.ship.<comment id>-<updatedAt>` for a human comment, `stale.ship.digest.<gate digest>` for a body edit. */
export function staleShipId(staleness: Exclude<ShipStaleness, { kind: "missing" }>): string {
	if (staleness.kind === "digest") return `stale.ship.digest.${staleness.digest}`;
	return `stale.ship.${staleness.comment.id}-${staleness.comment.updatedAt.replace(ID_UNSAFE, "")}`;
}
