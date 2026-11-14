import type { Decision } from "./decision.ts";
import { parseGitDiff } from "./git-diff.ts";
import type { Result } from "./result.ts";

const DECISION_PATH = /^specs\/decisions\/[^/]+\.md$/;

function label(d: Decision): string {
	return `specs/decisions/${String(d.number).padStart(4, "0")}-${d.slug}.md`;
}

function error(code: string, file: string, message: string): Result {
	return { code, severity: "error", file, message };
}

/** Checks numbers are unique and `superseded` decisions point at an existing decision. */
export function validateDecisions(ds: Decision[]): Result[] {
	const results: Result[] = [];
	const numbers = new Set(ds.map((d) => d.number));
	const seen = new Set<number>();
	for (const d of ds) {
		if (Number.isNaN(d.number)) {
			results.push(error("decision-number", label(d), "Decision file name must start with a number: NNNN-<slug>.md"));
			continue;
		}
		if (seen.has(d.number)) results.push(error("decision-number", label(d), `Duplicate decision number ${d.number}`));
		seen.add(d.number);
		if (d.status !== "superseded") continue;
		if (d.supersededBy === undefined) {
			results.push(error("decision-superseded", label(d), "A superseded decision requires superseded_by"));
		} else if (!numbers.has(d.supersededBy)) {
			results.push(error("decision-superseded", label(d), `superseded_by ${d.supersededBy} names no existing decision`));
		}
	}
	return results;
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
