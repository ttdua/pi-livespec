// The ship and close next steps (design D10): the pull request outcome rule (precedence 2), the ship steps
// (ship-phase "Ship next steps") and the close steps (change-close "Close next steps"). Pure: git facts come
// from `state.ship`, filled at refresh.

import { gateResultDecision } from "../engine/gate-decision.ts";
import { validApproval } from "../engine/locks.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState, Decision } from "../engine/state-types.ts";
import { SHIP_PHASE } from "./phase.ts";

const CLOSE_PHASE = "close";
const REVIEW_PHASE = "review";

const phaseOf = (state: ChangeState): string | undefined => (state.phase.kind === "ok" ? state.phase.id : undefined);
const hasSuccessor = (pack: Pack, phase: string): boolean => pack.phases.some((p) => p.requires.includes(phase));

/** Precedence 2: outside the last phase and while the issue is open, a merged or closed pull request decides. */
export function prOutcomeStep(state: ChangeState, pack: Pack): Decision | undefined {
	const phase = phaseOf(state);
	const pr = state.pr;
	if (phase === undefined || pr === undefined || state.issue.state !== "open" || !hasSuccessor(pack, phase)) return undefined;
	if (pr.merged) return { next: `The pull request #${pr.number} is merged: move to ${CLOSE_PHASE}.`, advance: CLOSE_PHASE };
	if (pr.state === "closed") {
		return { next: `The pull request #${pr.number} was closed without merge: reopen it on the forge, or abandon the change with change_close --abandon <reason>.` };
	}
	return undefined;
}

/** Whether the valid ship gate result approves exactly HEAD, as `change_push` requires for a re-confirmation. */
function shipApprovedAtHead(state: ChangeState): boolean {
	const gate = state.lock.gates[SHIP_PHASE];
	return validApproval(gate) && gate?.headSha === state.git.head;
}

/** The ship gate decides the re-confirmation: its result when HEAD is covered, else the gate is ready again. */
function reconfirmation(state: ChangeState, pack: Pack): Decision {
	const phase = pack.phases.find((p) => p.id === SHIP_PHASE);
	if (phase === undefined) return { next: `Ready for the ${SHIP_PHASE} gate.` };
	// An approval of another HEAD counts as no approval for this purpose, so its decision is the gate's own sentence.
	const result = state.lock.gates[SHIP_PHASE];
	const stale = validApproval(result) && result?.headSha !== state.git.head;
	return gateResultDecision(phase, CLOSE_PHASE, stale ? undefined : result, false);
}

/** Ship-phase "Ship next steps"; undefined when the gate decides (no `PR` line). */
export function shipStep(state: ChangeState, pack: Pack): Decision | undefined {
	if (phaseOf(state) !== SHIP_PHASE) return undefined;
	if (state.ship?.reviewed === false) return { next: "New commits after the reviewed SHA need review: move to review.", advance: REVIEW_PHASE };
	const line = state.change.header.pr;
	if (line === undefined) return undefined;
	const pr = state.pr;
	if (pr === undefined) return { next: `The pull request ${line} cannot be read (see the warnings): run spec_next again once the forge answers.` };
	const number = pr.number;
	// Reached with a closed or merged pull request only once the issue is closed (the outcome rule fires before).
	if (pr.state !== "open") return { next: `The pull request #${number} and the change issue are closed: nothing is left to do.` };
	if (pr.pushedHead === state.git.head) return { next: `Wait for a human to merge #${number} on the forge.` };
	if (state.ship?.needsShipGate === true && !shipApprovedAtHead(state)) return reconfirmation(state, pack);
	return { next: `Run change_push to update #${number}.` };
}

/** Change-close "Close next steps": `change_close` while the issue is open; the gate says the rest once it is closed. */
export function closeStep(state: ChangeState, _pack: Pack): Decision | undefined {
	if (phaseOf(state) !== CLOSE_PHASE || state.issue.state !== "open") return undefined;
	return { next: "Run change_close." };
}
