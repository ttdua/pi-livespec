// Why `unit_start` and `unit_finish` refuse (design D10): small named rules in
// order, the first that refuses wins. Pure over the change state.

import type { Unit } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { displayUnitId } from "../interaction/display-ids.ts";
import { unitRoot } from "../subagents/state.ts";

export type FinishMode = "reconcile" | "run";

type Input = { state: ChangeState; pack: Pack; unit: string; target: Unit | undefined };
type Rule = (i: Input) => string | undefined;

const AMEND = "amend it with unit_amend first";

const unitText = (i: Input): string => displayUnitId(i.unit);

// --- shared rules ---------------------------------------------------------------------

const unknownUnit: Rule = (i) => (i.target === undefined ? `${unitText(i)} is not a unit of this change.` : undefined);

const changedSinceLock: Rule = ({ state, unit }) => {
	const why = state.lock.frozen.includes(unit) ? "frozen" : state.lock.staleUnits.includes(unit) ? "stale" : undefined;
	return why === undefined ? undefined : `${displayUnitId(unit)} is ${why} since the plan was locked: ${AMEND}.`;
};

/** The refusal of a blocked unit, or undefined; exported so `unit_finish` can add its evidence links. */
export function blockedRefusal(state: ChangeState, unit: string): string | undefined {
	const reason = state.evidence.blocked[unit];
	return reason === undefined ? undefined : `${displayUnitId(unit)} is BLOCKED (${reason}): send a stuck report with spec_stuck.`;
}

const blockedUnit: Rule = ({ state, unit }) => blockedRefusal(state, unit);

/** A stale state may miss the latest evidence; deciding from it could double-start or double-count. */
const staleState: Rule = ({ state }) =>
	state.stale ? "the change state is stale (forge unreachable or login unknown); retry when the forge is reachable" : undefined;

/** A parked change builds nothing until `change_resume` (discovered-dependencies "Parked state"). */
const parkedChange: Rule = ({ state }) => {
	const core = state.parkedCore;
	if (core === undefined) return undefined;
	const waits = core.waitsFor.length === 0 ? "" : ` waiting for ${core.waitsFor.map((n) => `#${n}`).join(", ")}`;
	return `The change is parked${waits}: a human resumes it with change_resume #${state.issue.number} once they merge.`;
};

const dirtyTree: Rule = ({ state }) => (state.git.dirty ? "The working tree is dirty: commit your changes first, then call the tool again." : undefined);

// --- unit_start -----------------------------------------------------------------------

const notPerUnit: Rule = ({ state, pack }) => {
	const id = state.phase.kind === "ok" ? state.phase.id : undefined;
	const phase = pack.phases.find((p) => p.id === id);
	return phase?.per === "unit" ? undefined : `The change is not in a per: unit phase (phase ${id ?? "unknown"}); units are built in the build phase.`;
};

const notLocked: Rule = ({ state }) => (state.lock.locked === undefined ? "The plan is not locked yet: pass the plan gate first." : undefined);

const doneForStart: Rule = (i) => (i.target?.done ? `${unitText(i)} is already done.` : undefined);

const unmetDepends: Rule = ({ state, target }) => {
	if (target === undefined) return undefined;
	const done = new Set(state.change.units.filter((u) => u.done).map((u) => u.id));
	const unmet = target.depends.filter((d) => !done.has(d));
	return unmet.length === 0 ? undefined : `${displayUnitId(target.id)} depends on ${unmet.map(displayUnitId).join(", ")}, which ${unmet.length === 1 ? "is" : "are"} not done.`;
};

/** Started with the current digest; an approved amendment that changed the unit allows a restart. */
const alreadyStarted: Rule = ({ state, unit, target }) => {
	const start = state.evidence.started[unit];
	if (start === undefined || target === undefined || start.digest !== unitDigest(target)) return undefined;
	return `${displayUnitId(unit)} is already started: finish it with unit_finish ${displayUnitId(unit)}.`;
};

/** Another started unit in the same worktree: a lane is its own worktree, so units in different lanes do not collide. */
const otherStarted: Rule = ({ state, unit }) => {
	const here = unitRoot(state, unit, "");
	const other = Object.keys(state.evidence.started).find((id) => id !== unit && unitRoot(state, id, "") === here);
	return other === undefined ? undefined : `${displayUnitId(other)} is started: finish it with unit_finish ${displayUnitId(other)} first; one unit at a time in a worktree.`;
};

const START_RULES: Rule[] = [notPerUnit, parkedChange, notLocked, unknownUnit, doneForStart, changedSinceLock, unmetDepends, blockedUnit, alreadyStarted, staleState, dirtyTree, otherStarted];

function firstRefusal(rules: Rule[], state: ChangeState, pack: Pack, unit: string): string | undefined {
	const input: Input = { state, pack, unit, target: state.change.units.find((u) => u.id === unit) };
	for (const rule of rules) {
		const refusal = rule(input);
		if (refusal !== undefined) return refusal;
	}
	return undefined;
}

/** Why `unit_start <unit>` refuses before any run, or undefined. The guard check on `Verify` comes after. */
export function unitStartRefusal(state: ChangeState, pack: Pack, unit: string): string | undefined {
	return firstRefusal(START_RULES, state, pack, unit);
}

/** A refactor unit must already have its test, so it can never be verifier pending. */
export function refactorPendingRefusal(u: Unit, pending: boolean): string | undefined {
	return u.kind === "refactor" && pending ? `${displayUnitId(u.id)} is a refactor unit, but a refactor needs an existing test: amend it with unit_amend.` : undefined;
}

// --- unit_finish ----------------------------------------------------------------------

/** Reconcile ticks a receipted, unticked unit; anything else runs `Verify`. */
export function finishMode(state: ChangeState, unit: string): FinishMode {
	return state.evidence.untickedReceipts.includes(unit) ? "reconcile" : "run";
}

const doneForFinish: Rule = (i) => (i.target?.done ? `${unitText(i)} is already done: nothing to finish.` : undefined);

const notStarted: Rule = ({ state, unit }) => {
	if (state.evidence.started[unit] !== undefined) return undefined;
	const why = unit in (state.evidence.rebuilds ?? {}) ? "is marked for rebuild by a review" : "is not started";
	return `${displayUnitId(unit)} ${why}: run unit_start ${displayUnitId(unit)} first.`;
};

const digestChanged: Rule = ({ state, unit, target }) => {
	const start = state.evidence.started[unit];
	if (start === undefined || target === undefined || start.digest === unitDigest(target)) return undefined;
	return `${displayUnitId(unit)} changed since unit_start: ${AMEND}, then run unit_start ${displayUnitId(unit)} again.`;
};

/** A unit whose lane is still open merges with `lane_merge` first: finishing would run `Verify` in the wrong worktree. */
const openLane: Rule = ({ state, unit }) =>
	unit in state.subagents.lanes ? `${displayUnitId(unit)} has an open lane: merge it with lane_merge ${displayUnitId(unit)} first.` : undefined;

const RUN_RULES: Rule[] = [parkedChange, unknownUnit, doneForFinish, notStarted, openLane, changedSinceLock, digestChanged, blockedUnit, staleState, dirtyTree];
const INVARIANT_RULES: Rule[] = [unknownUnit, changedSinceLock, digestChanged, blockedUnit];
const RECONCILE_RULES: Rule[] = [parkedChange, openLane, dirtyTree, changedSinceLock];

const LANE_OPEN_RULES: Rule[] = [notPerUnit, notLocked, ...INVARIANT_RULES];

/** Why `lane_open <unit>` refuses before the lane rules: the phase, the lock, then the unit invariants. */
export function laneOpenRefusal(state: ChangeState, pack: Pack, unit: string): string | undefined {
	return firstRefusal(LANE_OPEN_RULES, state, pack, unit);
}

/** The unit invariants `lane_merge` shares with `unit_finish`: known, not frozen or stale, digest as at the start, not blocked. */
export function unitInvariantRefusal(state: ChangeState, pack: Pack, unit: string): string | undefined {
	return firstRefusal(INVARIANT_RULES, state, pack, unit);
}

/** Why `unit_finish <unit>` refuses in `mode`, or undefined. Reconcile applies only the open-lane, clean-tree, frozen and stale rules. */
export function unitFinishRefusal(state: ChangeState, pack: Pack, unit: string, mode: FinishMode): string | undefined {
	return firstRefusal(mode === "reconcile" ? RECONCILE_RULES : RUN_RULES, state, pack, unit);
}
