// The `ship` marker: one record per pushed head of the pull request.

import { type MarkedComment, registerKind, writeMarked } from "../forge/markers.ts";

export const SHIP_KIND = "ship";
registerKind(SHIP_KIND);

export type ShipRecord = { pr: number; pushedHead: string; confirmed: string[] };

export function shipComment(record: ShipRecord): string {
	return writeMarked(SHIP_KIND, `ship.${record.pr}.${record.pushedHead}`, record);
}

function asRecord(m: MarkedComment): ShipRecord | undefined {
	const d = m.data as Partial<ShipRecord> | null;
	if (typeof d !== "object" || d === null || typeof d.pr !== "number" || typeof d.pushedHead !== "string") return undefined;
	return { pr: d.pr, pushedHead: d.pushedHead, confirmed: Array.isArray(d.confirmed) ? d.confirmed.filter((c): c is string => typeof c === "string") : [] };
}

/** The last own `ship` record in comment order. */
export function latestShipRecord(marked: MarkedComment[]): ShipRecord | undefined {
	return marked
		.filter((m) => m.kind === SHIP_KIND)
		.map(asRecord)
		.filter((r): r is ShipRecord => r !== undefined)
		.pop();
}
