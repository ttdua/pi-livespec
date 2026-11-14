import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseDecision } from "../core/decision.ts";
import { parseGlossary } from "../core/glossary.ts";
import type { Result } from "../core/result.ts";
import { parseSpec } from "../core/spec.ts";
import { validateDecisions } from "../core/validate-decisions.ts";
import { validateGlossary, validateSpec } from "../core/validate-spec.ts";

async function entries(dir: string) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return null;
	}
}

async function readOptional(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function validateCapabilities(specsDir: string, names: string[]): Promise<Result[]> {
	const out: Result[] = [];
	for (const name of names) {
		const text = await readOptional(join(specsDir, name, "spec.md"));
		if (text === null) continue;
		out.push(...validateSpec(parseSpec(text, name), `specs/${name}/spec.md`));
	}
	return out;
}

async function validateDecisionFiles(specsDir: string): Promise<Result[]> {
	const dir = join(specsDir, "decisions");
	const files = ((await entries(dir)) ?? []).filter((e) => e.isFile() && e.name.endsWith(".md"));
	const decisions = [];
	for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
		const text = await readFile(join(dir, f.name), "utf8");
		decisions.push(parseDecision(`specs/decisions/${f.name}`, text));
	}
	return validateDecisions(decisions);
}

/** Walk `specs/` and run every applicable check. Free-text files are not checked. */
export async function runValidate(root: string): Promise<Result[]> {
	const specsDir = join(root, "specs");
	const top = await entries(specsDir);
	if (top === null) return [];
	const caps = top
		.filter((e) => e.isDirectory() && e.name !== "decisions")
		.map((e) => e.name)
		.sort();
	const results = await validateCapabilities(specsDir, caps);
	const glossary = await readOptional(join(specsDir, "glossary.md"));
	if (glossary !== null) results.push(...validateGlossary(parseGlossary(glossary), "specs/glossary.md"));
	results.push(...(await validateDecisionFiles(specsDir)));
	return results;
}

export function hasErrors(results: Result[]): boolean {
	return results.some((r) => r.severity === "error");
}

export function formatResults(results: Result[]): string {
	if (results.length === 0) return "No validation results.";
	return results
		.map((r) => {
			const where = [r.file, r.line === undefined ? undefined : String(r.line)].filter(Boolean).join(":");
			return `${r.severity} ${r.code}${where ? ` ${where}` : ""}: ${r.message}`;
		})
		.join("\n");
}
