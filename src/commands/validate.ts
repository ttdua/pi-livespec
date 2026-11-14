import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { type Decision, parseDecision } from "../core/decision.ts";
import { parseGlossary } from "../core/glossary.ts";
import type { Result } from "../core/result.ts";
import { parseSpec } from "../core/spec.ts";
import { validateDecisions } from "../core/validate-decisions.ts";
import { validateGlossary, validateSpec } from "../core/validate-spec.ts";

/** A value (null when an optional path is absent) or the error Result explaining the failure. */
type Outcome<T> = { value: T } | { error: Result };

function isAbsent(e: unknown): boolean {
	return (e as NodeJS.ErrnoException).code === "ENOENT";
}

function failure(code: string, file: string, e: unknown): { error: Result } {
	const message = e instanceof Error ? e.message : String(e);
	return { error: { code, severity: "error", file, message } };
}

/** Only ENOENT means "absent"; every other failure becomes an error Result. */
async function entries(dir: string, file: string): Promise<Outcome<Dirent[] | null>> {
	try {
		return { value: await readdir(dir, { withFileTypes: true }) };
	} catch (e) {
		return isAbsent(e) ? { value: null } : failure("file-unreadable", file, e);
	}
}

async function readOptional(path: string, file: string): Promise<Outcome<string | null>> {
	try {
		return { value: await readFile(path, "utf8") };
	} catch (e) {
		return isAbsent(e) ? { value: null } : failure("file-unreadable", file, e);
	}
}

/** Per-file error boundary: a parser/validator throw becomes a `file-parse` Result. */
function guarded(file: string, fn: () => Result[]): Result[] {
	try {
		return fn();
	} catch (e) {
		return [failure("file-parse", file, e).error];
	}
}

async function validateCapabilities(specsDir: string, names: string[]): Promise<Result[]> {
	const out: Result[] = [];
	for (const name of names) {
		const file = `specs/${name}/spec.md`;
		const read = await readOptional(join(specsDir, name, "spec.md"), file);
		if ("error" in read) out.push(read.error);
		else if (read.value !== null) {
			const text = read.value;
			out.push(...(guarded(file, () => validateSpec(parseSpec(text, name), file))));
		}
	}
	return out;
}

async function validateGlossaryFile(specsDir: string): Promise<Result[]> {
	const file = "specs/glossary.md";
	const read = await readOptional(join(specsDir, "glossary.md"), file);
	if ("error" in read) return [read.error];
	if (read.value === null) return [];
	const text = read.value;
	return guarded(file, () => validateGlossary(parseGlossary(text), file));
}

async function validateDecisionFiles(specsDir: string): Promise<Result[]> {
	const dir = join(specsDir, "decisions");
	const listing = await entries(dir, "specs/decisions");
	if ("error" in listing) return [listing.error];
	const files = (listing.value ?? []).filter((e) => e.isFile() && e.name.endsWith(".md"));
	const errors: Result[] = [];
	const decisions: Decision[] = [];
	for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
		const file = `specs/decisions/${f.name}`;
		const read = await readOptional(join(dir, f.name), file);
		if ("error" in read) {
			errors.push(read.error);
			continue;
		}
		if (read.value === null) continue;
		const text = read.value;
		try {
			decisions.push(parseDecision(file, text));
		} catch (e) {
			errors.push(failure("file-parse", file, e).error);
		}
	}
	return [...errors, ...validateDecisions(decisions)];
}

/** Walk `specs/` and run every applicable check. Free-text files are not checked. */
export async function runValidate(root: string): Promise<Result[]> {
	const specsDir = join(root, "specs");
	const top = await entries(specsDir, "specs");
	if ("error" in top) return [top.error];
	if (top.value === null) return [];
	const caps = top.value
		.filter((e) => e.isDirectory() && e.name !== "decisions")
		.map((e) => e.name)
		.sort();
	return [
		...(await validateCapabilities(specsDir, caps)),
		...(await validateGlossaryFile(specsDir)),
		...(await validateDecisionFiles(specsDir)),
	];
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

export type ValidateCommandResult = { message: string; results: Result[]; exitCode: 0 | 1 };

async function specsAbsent(root: string): Promise<boolean> {
	try {
		await stat(join(root, "specs"));
		return false;
	} catch (e) {
		return isAbsent(e);
	}
}

/**
 * Boundary shared by the slash command and the `spec_validate` tool.
 * pi slash commands have no process exit code, so `exitCode` (1 iff any error) is
 * surfaced by the callers: error-level notification and `isError` on the tool result.
 */
export async function runValidateCommand(root: string): Promise<ValidateCommandResult> {
	if (await specsAbsent(root)) return { message: "Nothing to validate: no specs/ folder.", results: [], exitCode: 0 };
	const results = await runValidate(root);
	return { message: formatResults(results), results, exitCode: hasErrors(results) ? 1 : 0 };
}
