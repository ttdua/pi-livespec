// The parked core of a change (design D3a), derived from own `parked` comments
// only, so answer validation sees it exactly as the refresh snapshot does.

import type { MarkedComment } from "../forge/markers.ts";
import type { ParkedUnit } from "./deps-facts.ts";

const PARKED_KIND = "parked";

export type ParkedCore = { index: number; waitsFor: number[]; units: ParkedUnit[]; at: string };

type ParkedData = { waits_for?: unknown; units?: unknown; at?: unknown; resumed?: unknown };

const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

function isParkedUnit(x: unknown): x is ParkedUnit {
	if (typeof x !== "object" || x === null) return false;
	const u = x as Record<string, unknown>;
	const optionalString = (v: unknown) => v === undefined || typeof v === "string";
	return typeof u.unit === "string" && typeof u.lane === "boolean" && optionalString(u.branch) && optionalString(u.head);
}

/**
 * The latest own `parked` record, with its index in `marked`; undefined when there is none or the latest
 * one is a resume. Malformed list items are dropped, since the record is forge data.
 */
export function parkedRecord(marked: MarkedComment[]): ParkedCore | undefined {
	let index = -1;
	marked.forEach((m, i) => {
		if (m.kind === PARKED_KIND) index = i;
	});
	if (index < 0) return undefined;
	const raw = marked[index]?.data;
	const data: ParkedData = typeof raw === "object" && raw !== null ? (raw as ParkedData) : {};
	if (data.resumed === true) return undefined;
	return {
		index,
		waitsFor: Array.isArray(data.waits_for) ? data.waits_for.filter(isNumber) : [],
		units: Array.isArray(data.units) ? data.units.filter(isParkedUnit) : [],
		at: typeof data.at === "string" ? data.at : "",
	};
}
