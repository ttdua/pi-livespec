import { validateGlob } from "./glob.ts";
import type { Glossary } from "./glossary.ts";
import type { Result } from "./result.ts";
import type { Spec } from "./spec.ts";

const NORMATIVE = /\b(SHALL|MUST)\b/;

function error(code: string, file: string, message: string, line?: number): Result {
	return { code, severity: "error", file, ...(line === undefined ? {} : { line }), message };
}

/** Checks a living spec: normative wording, scenarios, WHEN/THEN, unique names, `paths` globs. */
export function validateSpec(s: Spec, file: string): Result[] {
	const results: Result[] = [];
	for (const pattern of s.paths) {
		const problem = validateGlob(pattern);
		if (problem) results.push(error("spec-paths-glob", file, `Invalid paths glob "${pattern}": ${problem}`));
	}
	const seen = new Set<string>();
	for (const req of s.requirements) {
		if (seen.has(req.name)) {
			results.push(error("spec-duplicate-requirement", file, `Duplicate requirement name "${req.name}"`, req.line));
		}
		seen.add(req.name);
		if (!NORMATIVE.test(req.text)) {
			results.push(error("spec-normative", file, `Requirement "${req.name}" needs SHALL or MUST`, req.line));
		}
		if (req.scenarios.length === 0) {
			results.push(error("spec-scenario-missing", file, `Requirement "${req.name}" has no scenario`, req.line));
		}
		for (const sc of req.scenarios) {
			const missing = [sc.when.length === 0 ? "WHEN" : "", sc.then.length === 0 ? "THEN" : ""].filter(Boolean);
			if (missing.length > 0) {
				results.push(error("spec-when-then", file, `Scenario "${sc.name}" lacks ${missing.join(" and ")}`, sc.line));
			}
		}
	}
	return results;
}

/** Checks glossary terms: sorted A to Z (case-insensitive) and unique. */
export function validateGlossary(g: Glossary, file: string): Result[] {
	const results: Result[] = [];
	const seen = new Set<string>();
	let previous: string | undefined;
	for (const e of g.entries) {
		const key = e.term.toLowerCase();
		if (seen.has(key)) results.push(error("glossary-duplicate", file, `Duplicate term "${e.term}"`, e.line));
		else if (previous !== undefined && key < previous) {
			results.push(error("glossary-order", file, `Term "${e.term}" is out of A to Z order`, e.line));
		}
		seen.add(key);
		previous = key;
	}
	return results;
}
