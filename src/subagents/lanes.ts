// Pure lane rules: lane naming, which ready units may open a lane, and why `lane_open` refuses one.

import { join } from "node:path";
import type { Unit } from "../core/change.ts";
import type { ChangeState } from "../engine/state-types.ts";

export const LANES_DIR = ".worktrees";

/** The change name in lane paths and branches: the last segment of the change branch, else `issue-<n>`. */
export const laneChange = (state: Pick<ChangeState, "change" | "issue">): string => state.change.header.branch?.split("/").at(-1) || `issue-${state.issue.number}`;

export const lanePath = (root: string, change: string, unit: string): string => join(root, LANES_DIR, `${change}--${unit}`);

export const laneBranch = (change: string, unit: string): string => `livespec/${change}--lane-${unit}`;

type LaneFacts = Pick<ChangeState, "change" | "evidence" | "subagents">;

const doneIds = (state: LaneFacts): Set<string> => new Set(state.change.units.filter((u) => u.done).map((u) => u.id));

const isReady = (u: Unit, done: Set<string>): boolean => !u.done && u.depends.every((d) => done.has(d));

/** Two units collide when they list a common file (spec files included). */
const overlaps = (u: Unit, others: Unit[]): Unit | undefined => others.find((o) => o.files.some((f) => u.files.includes(f)));

const unitsOf = (state: LaneFacts, ids: string[]): Unit[] => state.change.units.filter((u) => ids.includes(u.id));

/** Why `unit` may not open a lane next to the open lanes, or undefined; checked in the `lane_open` order. */
export function laneRefusal(state: LaneFacts, unit: string, max: number): string | undefined {
	const { executor, lanes } = state.subagents;
	if (!executor.ok) return `no capable subagent executor is present (missing ${executor.missing.join(", ")}); run ${unit} in the change worktree.`;
	const target = state.change.units.find((u) => u.id === unit);
	if (target === undefined || !isReady(target, doneIds(state))) return `${unit} is not a ready unit.`;
	if (unit in state.evidence.started) return `${unit} is already started.`;
	if (state.evidence.untickedReceipts.includes(unit)) return `${unit} has a receipt but no tick: run unit_finish ${unit} again instead.`;
	if (unit in lanes) return `${unit} already has an open lane.`;
	const open = Object.keys(lanes);
	if (open.length >= max) return `${open.length} lane(s) are open and the limit (lanes) is ${max}.`;
	const clash = overlaps(target, unitsOf(state, open));
	return clash === undefined ? undefined : `${unit} shares Files with ${clash.id}, whose lane is open.`;
}

/** Ready, unstarted, unreceipted units that may run together, in change order, at most `max` minus the open lanes. */
export function eligibleLanes(state: LaneFacts, max: number): string[] {
	if (!state.subagents.executor.ok) return [];
	const room = max - Object.keys(state.subagents.lanes).length;
	const done = doneIds(state);
	const taken = unitsOf(state, Object.keys(state.subagents.lanes));
	const picked: string[] = [];
	for (const u of state.change.units) {
		if (picked.length >= room) break;
		const busy = u.id in state.evidence.started || u.id in state.subagents.lanes || state.evidence.untickedReceipts.includes(u.id);
		if (!isReady(u, done) || busy || overlaps(u, taken)) continue;
		picked.push(u.id);
		taken.push(u);
	}
	return picked;
}
