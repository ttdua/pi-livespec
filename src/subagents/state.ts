// Lane records (open worktrees of parallel units) and the worktree a unit's tools run in.

import { type MarkedComment, registerKind, writeMarked } from "../forge/markers.ts";
import { isLaneData } from "./validate.ts";
import type { ChangeState } from "../engine/state-types.ts";

registerKind("lane");

export type LaneRecord = { unit: string; path: string; branch: string; base: string };
export type LaneData = LaneRecord & { closed?: true };

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

/** The unit's open lane path, else `root`, the change worktree root. */
export function unitRoot(state: Pick<ChangeState, "subagents">, unit: string, root: string): string {
	return state.subagents.lanes[unit]?.path ?? root;
}
