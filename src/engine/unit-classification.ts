// The `unit-classification` check: each unit's Difficulty and Tags must equal
// the latest decision record for that unit and point. Records whose digest is
// not the unit's current digest belong to an older contract and are ignored.

import type { Unit } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import type { Result } from "../core/result.ts";
import { type DecisionRecord, latestDecisions } from "../decide/records.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { CheckFn } from "./registry.ts";

const CODE = "unit-classification";

type Point = { point: "tags" | "difficulty"; field: "Tags" | "Difficulty" };
const POINTS: Point[] = [
	{ point: "tags", field: "Tags" },
	{ point: "difficulty", field: "Difficulty" },
];

/** The canonical text of a classification value, as the body shows it. */
function show(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(String).join(", ")}]`;
	return value === undefined ? "(missing)" : String(value);
}

function bodyValue(unit: Unit, point: Point["point"]): unknown {
	return point === "tags" ? unit.tags : unit.difficulty;
}

/** Latest record per `<point>.<unit>` that is for the given digest; older-contract records are skipped. */
function recordsForDigests(marked: MarkedComment[], digests: Map<string, string>): Map<string, DecisionRecord> {
	const current = new Map<string, DecisionRecord>();
	const relevant = marked.filter((m) => m.kind !== "decision" || isCurrent(m, digests));
	for (const [id, record] of latestDecisions(relevant)) current.set(id, record);
	return current;
}

function isCurrent(m: MarkedComment, digests: Map<string, string>): boolean {
	const d = m.data as { subject?: unknown; digest?: unknown } | null;
	return typeof d?.subject === "string" && d.digest === digests.get(d.subject);
}

function unitResults(unit: Unit, records: Map<string, DecisionRecord>): Result[] {
	const results: Result[] = [];
	for (const { point, field } of POINTS) {
		const record = records.get(`${point}.${unit.id}`);
		const error = (message: string): Result => ({ code: CODE, severity: "error", section: unit.id, message: `${unit.id}: ${message}` });
		if (!record) {
			results.push(error(`no ${point} decision record for its current contract`));
			continue;
		}
		const actual = show(bodyValue(unit, point));
		const expected = show(record.outcome);
		if (actual !== expected) results.push(error(`${field} ${actual} does not match the ${point} decision ${expected}`));
	}
	return results;
}

export const unitClassification: CheckFn = async ({ change, marked }) => {
	const digests = new Map(change.units.map((u) => [u.id, unitDigest(u)]));
	const records = recordsForDigests(marked, digests);
	return change.units.flatMap((u) => unitResults(u, records));
};
