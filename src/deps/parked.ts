// The parked state (spec discovered-dependencies "Parked state", design D13/D14): the `parked` record writer,
// the waiting list from current dependencies, the resumed-unit rule of unit-evidence, the wip branch name and
// next-step rule 6. Pure.

import type { DepFact, ParkedUnit } from "../engine/deps-facts.ts";
import { isResumeRecord, type ParkedCore, parkedUnitsOf } from "../engine/parked.ts";
import type { ChangeState, Decision } from "../engine/state-types.ts";
import { asStartRecord } from "../evidence/records.ts";
import { type MarkedComment, writeMarked } from "../forge/markers.ts";
import "./markers.ts";

export type ParkData = { waits_for: number[]; units: ParkedUnit[]; at: string };
export type ResumeData = { resumed: true; at: string };

const PARKED_KIND = "parked";
const WIP_SUFFIX = "--wip-";
const NONE = -1;

/** The `parked` comment body, id `parked.<base36 ms>`. */
export function parkedComment(data: ParkData | ResumeData, now: Date = new Date()): string {
	return writeMarked(PARKED_KIND, `${PARKED_KIND}.${now.getTime().toString(36)}`, data);
}

/** `<Branch line>--wip-<unit>`: the branch a parked unit's work is pushed to. */
export function wipBranch(branch: string, unit: string): string {
	return `${branch}${WIP_SUFFIX}${unit}`;
}

/**
 * The parked fact: the current dependencies (`deps`) that the record names, with their states; a dependency
 * removed from `Depends` after the park is no longer waited for. Undefined while not parked.
 */
export function parkedState(core: ParkedCore | undefined, deps: DepFact[]): ChangeState["parked"] {
	if (core === undefined) return undefined;
	const named = new Set(core.waitsFor);
	return { waitsFor: deps.filter((d) => named.has(d.number)), units: core.units, at: core.at };
}

/** A `parked` record newer than the unit's latest `unit-start` lists it, and a resume record follows that record. */
export function isResumedUnit(marked: MarkedComment[], unit: string): boolean {
	let start = NONE;
	let park = NONE;
	let resume = NONE;
	marked.forEach((m, i) => {
		if (asStartRecord(m, i)?.unit === unit) start = i;
		if (parkedUnitsOf(m).includes(unit)) park = i;
		if (isResumeRecord(m)) resume = i;
	});
	return park > start && resume > park;
}

const issueList = (deps: DepFact[]): string => deps.map((d) => `#${d.number}`).join(", ");

/**
 * Next-step rule 6: while parked, the waited-for changes not merged yet; once all are merged (or none is
 * waited for any more), a human runs `change_resume #N`. Before the refresh fills `parked`, the record's
 * numbers are named as waited for.
 */
export function parkedStep(state: ChangeState): Decision | undefined {
	const core = state.parkedCore;
	if (core === undefined) return undefined;
	const n = state.issue.number;
	const parked = state.parked;
	if (parked === undefined) return { next: `#${n} is parked waiting for ${core.waitsFor.map((d) => `#${d}`).join(", ")} to merge.` };
	const waiting = parked.waitsFor.filter((d) => d.state !== "merged");
	if (waiting.length > 0) return { next: `#${n} is parked waiting for ${waiting.map((d) => `#${d.number} ${d.state}`).join(", ")} to merge.` };
	const merged = parked.waitsFor.length === 0 ? "No change it waits for is left" : `${issueList(parked.waitsFor)} merged`;
	return { next: `${merged}: a human runs change_resume #${n}.` };
}
