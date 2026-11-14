import type { Decision } from "./decision.ts";
import { parseGitDiff } from "./git-diff.ts";
import type { Result } from "./result.ts";

const DECISION_PATH = /^specs\/decisions\/[^/]+\.md$/;

function error(code: string, file: string, message: string): Result {
	return { code, severity: "error", file, message };
}

function checkNumber(d: Decision, seen: Set<number>): Result[] {
	if (Number.isNaN(d.number)) {
		return [error("decision-number", d.file, "Decision file name must match NNNN-<slug>.md")];
	}
	const dup = seen.has(d.number);
	seen.add(d.number);
	return dup ? [error("decision-number", d.file, `Duplicate decision number ${d.number}`)] : [];
}

function checkSupersession(d: Decision, numbers: Set<number>): Result[] {
	if (d.status !== "superseded") return [];
	if (d.supersededBy === undefined) {
		return [error("decision-superseded", d.file, "A superseded decision requires superseded_by")];
	}
	if (!numbers.has(d.supersededBy)) {
		return [error("decision-superseded", d.file, `superseded_by ${d.supersededBy} names no existing decision`)];
	}
	return [];
}

function checkStatus(d: Decision): Result[] {
	if (d.statusRaw === "accepted" || d.statusRaw === "superseded") return [];
	const got = d.statusRaw === "" ? "missing" : `"${d.statusRaw}"`;
	return [error("decision-status", d.file, `status must be accepted or superseded (got ${got})`)];
}

/** Checks file names, numbers are unique, statuses are valid, and `superseded` decisions point at an existing decision. */
export function validateDecisions(ds: Decision[]): Result[] {
	const numbers = new Set(ds.map((d) => d.number));
	const seen = new Set<number>();
	return ds.flatMap((d) => [
		...checkNumber(d, seen),
		...checkStatus(d),
		...checkSupersession(d, numbers),
	]);
}

/** Reports decision files that a git diff deletes or renames away: a decision is never deleted, only superseded. */
export function validateDecisionDiff(diff: string): Result[] {
	const deleted = new Set<string>();
	for (const f of parseGitDiff(diff)) {
		if (!DECISION_PATH.test(f.oldPath)) continue;
		if (f.deletedFile || (f.renamed && !DECISION_PATH.test(f.newPath))) deleted.add(f.oldPath);
	}
	return [...deleted].map((file) =>
		error("decision-deleted", file, "A decision is never deleted, only superseded"),
	);
}
