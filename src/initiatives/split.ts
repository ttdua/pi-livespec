// Pure planning of `change_split` (design D8): which units move, the body #N keeps, and how the
// declared capabilities are partitioned between #N and the new change. Nothing here writes.

import type { Change, Unit } from "../core/change.ts";
import { joinLines } from "../core/lines.ts";
import { setHeaderLine } from "../core/sections.ts";
import { parkedRecord } from "../engine/parked.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { openRequestFor } from "../interaction/requests.ts";
import { openLanes } from "../subagents/state.ts";

export type Capabilities = { new: string[]; modified: string[] };

export type SplitPlan = {
	moved: Unit[];
	keptBody: string;
	newCapabilities: Capabilities;
	keptCapabilities: Capabilities;
	/** A moved unit lists a unit that stays in `Depends`, so the new change gets `Depends: #N`. */
	dependsOnN: boolean;
};

type Refused = { refused: string };

const PLAN_REQUEST = "gate:plan";

/** The capability a `Covers` item names: the part before `/Requirement:`. */
const capabilityOf = (covers: string): string => covers.split("/Requirement:")[0]!.trim();
const capabilitiesOf = (units: Unit[]): Set<string> => new Set(units.flatMap((u) => u.covers.map(capabilityOf)));

/** Units named by the latest `parked` record that is not a resume, so a resumed change still keeps them. */
function lastParkedUnits(marked: MarkedComment[]): string[] {
	const data = (m: MarkedComment) => (typeof m.data === "object" && m.data !== null ? (m.data as { resumed?: unknown }) : {});
	let at = -1;
	marked.forEach((m, i) => {
		if (m.kind === "parked" && data(m).resumed !== true) at = i;
	});
	return at < 0 ? [] : (parkedRecord(marked.slice(0, at + 1))?.units.map((u) => u.unit) ?? []);
}

function stateRefusal(state: ChangeState): string | undefined {
	if (state.parkedCore !== undefined) return "the change is parked; resume it with change_resume first.";
	const pending = openRequestFor(state.requests, PLAN_REQUEST);
	if (pending !== undefined) return `a ${PLAN_REQUEST} request is pending (${pending}); wait for its answer.`;
	return undefined;
}

/** Why `id` cannot move: unknown, done, started, in an open lane, or on the latest parked record. */
function unitRefusal(state: ChangeState, unit: Unit | undefined, id: string, parked: string[]): string | undefined {
	if (unit === undefined) return `${id} is not a unit of #${state.issue.number}.`;
	if (unit.done) return `${id} is done; a done unit cannot move.`;
	if (state.evidence.started[id] !== undefined) return `${id} is started; a started unit cannot move.`;
	if (openLanes(state.marked)[id] !== undefined) return `${id} is in an open lane; close the lane first.`;
	if (parked.includes(id)) return `${id} is named by the latest parked record; it cannot move.`;
	return undefined;
}

function movedOrRefusal(change: Change, state: ChangeState, ids: string[]): Unit[] | Refused {
	if (ids.length === 0) return { refused: "name at least one unit to move." };
	const parked = lastParkedUnits(state.marked);
	const moved: Unit[] = [];
	for (const id of new Set(ids)) {
		const unit = change.units.find((u) => u.id === id);
		const refused = unitRefusal(state, unit, id, parked);
		if (refused !== undefined) return { refused };
		moved.push(unit!);
	}
	if (moved.length === change.units.length) return { refused: "every unit would move; at least one unit must stay." };
	return moved;
}

function dependentRefusal(kept: Unit[], movedIds: Set<string>): string | undefined {
	for (const u of kept) {
		const on = u.depends.filter((d) => movedIds.has(d));
		if (on.length > 0) return `${u.id} stays and depends on ${on.join(", ")}; move ${u.id} too or amend its Depends first.`;
	}
	return undefined;
}

/** Moved capabilities go to the new change; #N drops those no remaining unit covers. */
function partition(declared: Capabilities, moved: Unit[], kept: Unit[]): { newCapabilities: Capabilities; keptCapabilities: Capabilities } {
	const movedCaps = [...capabilitiesOf(moved)];
	const stillCovered = capabilitiesOf(kept);
	const gone = (c: string) => movedCaps.includes(c) && !stillCovered.has(c);
	return {
		newCapabilities: { new: movedCaps.filter((c) => declared.new.includes(c)), modified: movedCaps.filter((c) => !declared.new.includes(c)) },
		keptCapabilities: { new: declared.new.filter((c) => !gone(c)), modified: declared.modified.filter((c) => !gone(c)) },
	};
}

export const capabilitiesValue = (c: Capabilities): string => `new [${c.new.join(", ")}], modified [${c.modified.join(", ")}]`;

/** The body without the moved blocks, each with the blank line that separated it, and with the kept Capabilities. */
function keptBodyOf(change: Change, moved: Unit[], caps: Capabilities): string {
	const drop = new Set<number>();
	for (const u of moved) {
		for (let i = u.startLine; i <= u.endLine; i++) drop.add(i);
		if (change.lines[u.startLine - 1]?.text.trim() === "") drop.add(u.startLine - 1);
	}
	const body = joinLines(change.lines.filter((_, i) => !drop.has(i)));
	return setHeaderLine(body, "Capabilities", capabilitiesValue(caps));
}

/** The split of `units` out of `change`, or why it is refused; nothing is written. */
export function planSplit(change: Change, state: ChangeState, units: string[]): SplitPlan | Refused {
	const blocked = stateRefusal(state);
	if (blocked !== undefined) return { refused: blocked };
	const moved = movedOrRefusal(change, state, units);
	if ("refused" in moved) return moved;
	const movedIds = new Set(moved.map((u) => u.id));
	const kept = change.units.filter((u) => !movedIds.has(u.id));
	const dependent = dependentRefusal(kept, movedIds);
	if (dependent !== undefined) return { refused: dependent };
	const declared = change.header.capabilities ?? { new: [], modified: [] };
	const { newCapabilities, keptCapabilities } = partition(declared, moved, kept);
	const keptIds = new Set(kept.map((u) => u.id));
	return {
		moved,
		keptBody: keptBodyOf(change, moved, keptCapabilities),
		newCapabilities,
		keptCapabilities,
		dependsOnN: moved.some((u) => u.depends.some((d) => keptIds.has(d))),
	};
}

/** The moved block lines of `change`, heading to status line, with the status reset to pending. */
export function pendingBlock(change: Change, unit: Unit): string[] {
	const lines = change.lines.slice(unit.startLine, unit.endLine + 1).map((l) => l.text);
	if (unit.statusLine >= 0) lines[unit.statusLine - unit.startLine] = "- [ ] pending";
	return lines;
}
