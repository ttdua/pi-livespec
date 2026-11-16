// The `unit-classification` check: each unit's Difficulty and Tags must equal
// the latest decision record for that unit and point. Records whose digest is
// not the unit's current digest belong to an older contract and are ignored.

import type { Unit } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import type { Result } from "../core/result.ts";
import { currentDecision } from "../decide/records.ts";
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

function unitResults(unit: Unit, marked: MarkedComment[]): Result[] {
	const digest = unitDigest(unit);
	const error = (message: string): Result => ({ code: CODE, severity: "error", section: unit.id, message: `${unit.id}: ${message}` });
	const results: Result[] = [];
	for (const { point, field } of POINTS) {
		const record = currentDecision(marked, point, unit.id, digest);
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

export const unitClassification: CheckFn = async ({ change, marked }) => change.units.flatMap((u) => unitResults(u, marked));
