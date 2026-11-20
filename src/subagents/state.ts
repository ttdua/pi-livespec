// Lane records (open worktrees of parallel units) and the worktree a unit's tools run in.

import { type MarkedComment, registerKind, writeMarked } from "../forge/markers.ts";
import { isLaneData, type LANE_OUTCOME_NAMES } from "./validate.ts";
import type { ChangeState } from "../engine/state-types.ts";

registerKind("lane");

export type LaneRecord = { unit: string; path: string; branch: string; base: string };
/** How a lane was closed: merged into the change branch, or one of the sequential re-run causes. */
export type LaneOutcome = (typeof LANE_OUTCOME_NAMES)[number];
/** A closed record may say how it closed and, when merged, which lane head the merge brought in. */
export type LaneData = LaneRecord & { closed?: true; outcome?: LaneOutcome; head?: string };

export function laneComment(data: LaneData): string {
	return writeMarked("lane", `lane.${data.unit}`, data);
}

const isLane = (d: unknown): d is LaneData => isLaneData(d);

/** Lane records whose data does not have the expected shape. */
export function invalidLanes(marked: MarkedComment[]): string[] {
	return marked.filter((m) => m.kind === "lane" && !isLane(m.data)).map((m) => `ignored invalid lane record ${m.commentId} (${m.id})`);
}

/** Units whose latest own `lane` record is not closed. */
export function openLanes(marked: MarkedComment[]): Record<string, LaneRecord> {
	const latest = new Map<string, LaneData>();
	for (const m of marked) {
		if (m.kind !== "lane") continue;
		if (!isLane(m.data)) continue;
		const data = m.data;
		latest.set(data.unit, data);
	}
	const open: Record<string, LaneRecord> = {};
	for (const [unit, { unit: u, path, branch, base, closed }] of latest) {
		if (closed !== true) open[unit] = { unit: u, path, branch, base };
	}
	return open;
}

/** The unit's latest closed `lane` record and its index in `marked`, or undefined. */
export function latestLaneClose(marked: MarkedComment[], unit: string): { index: number; data: LaneData } | undefined {
	for (let i = marked.length - 1; i >= 0; i--) {
		const m = marked[i] as MarkedComment;
		if (m.kind === "lane" && isLane(m.data) && m.data.unit === unit && m.data.closed === true) return { index: i, data: m.data };
	}
	return undefined;
}

/** The unit's open lane path, else `root`, the change worktree root. */
export function unitRoot(state: Pick<ChangeState, "subagents">, unit: string, root: string): string {
	return state.subagents.lanes[unit]?.path ?? root;
}
