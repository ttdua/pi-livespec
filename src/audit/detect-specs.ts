// Spec-side drift detectors: untested scenarios, removed references and dead
// `paths` globs of the living specs.

import { matchGlob } from "../core/glob.ts";
import type { Spec } from "../core/spec.ts";
import { type DriftItem, driftItem } from "./items.ts";
import { type FileText, livingSpecs, outsideSpecs, readFiles } from "./living-specs.ts";
import type { RepoView } from "./repo-view.ts";

const TEST_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/*_test.*", "tests/**", "test/**"];
const IDENTIFIER_CHARS = /^[A-Za-z][A-Za-z0-9_]*$/;
const CAPITALIZED_WORD = /^[A-Z][a-z0-9]+$/;
const MIN_IDENTIFIER = 4;
const GLOB_CHARS = /[*?[{]/;
const BACKTICKED = /`([^`\n]+)`/g;

/** A `camelCase`, `PascalCase`, `snake_case` or capitalized word of at least four characters; all-caps is not one. */
export function isIdentifierToken(token: string): boolean {
	if (token.length < MIN_IDENTIFIER || !IDENTIFIER_CHARS.test(token)) return false;
	return token.includes("_") || (/[a-z]/.test(token) && /[A-Z]/.test(token)) || CAPITALIZED_WORD.test(token);
}

/** A repository path: it contains `/` and no glob character. */
export function isPathToken(token: string): boolean {
	return token.includes("/") && !GLOB_CHARS.test(token);
}

const isTestFile = (path: string): boolean => outsideSpecs(path) && TEST_GLOBS.some((g) => matchGlob(g, path));

export async function detectSpecs(view: RepoView): Promise<DriftItem[]> {
	const specs = await livingSpecs(view);
	if (specs.length === 0) return [];
	const tests = (await readFiles(view, isTestFile)).map((f) => f.text.toLowerCase());
	const code = await readFiles(view, outsideSpecs);
	return specs.flatMap(({ file, spec }) => [
		...untestedScenarios(file, spec, tests),
		...removedReferences(file, spec, view.files, code),
		...deadPaths(file, spec, view.files),
	]);
}

function untestedScenarios(file: string, spec: Spec, tests: string[]): DriftItem[] {
	return spec.requirements.flatMap((req) =>
		req.scenarios
			.filter((s) => !tests.some((t) => t.includes(s.name.toLowerCase())))
			.map((s) => driftItem("scenario-untested", `${spec.capability}/${s.name}`, `${file}:${s.line} scenario "${s.name}" is named in no test file`, spec.capability)),
	);
}

function removedReferences(file: string, spec: Spec, files: string[], code: FileText[]): DriftItem[] {
	const items = new Map<string, DriftItem>();
	for (const req of spec.requirements) {
		for (const [, token = ""] of req.text.matchAll(BACKTICKED)) {
			const reason = missingReason(token, files, code);
			if (reason === undefined) continue;
			const item = driftItem("removed-reference", `${spec.capability}/${token}`, `${file}:${req.line} requirement "${req.name}" cites \`${token}\`, ${reason}`, spec.capability);
			if (!items.has(item.key)) items.set(item.key, item);
		}
	}
	return [...items.values()];
}

/** Why `token` is a removed reference, or undefined when it is not one. */
function missingReason(token: string, files: string[], code: FileText[]): string | undefined {
	if (isPathToken(token)) {
		const dir = token.endsWith("/") ? token : `${token}/`;
		return files.some((f) => f === token || f.startsWith(dir)) ? undefined : "which is not in the tree";
	}
	if (isIdentifierToken(token)) return code.some((f) => f.text.includes(token)) ? undefined : "which occurs in no file outside specs/";
	return undefined;
}

function deadPaths(file: string, spec: Spec, files: string[]): DriftItem[] {
	return spec.paths
		.filter((glob) => !files.some((f) => matchGlob(glob, f)))
		.map((glob) => driftItem("dead-paths", `${spec.capability}:${glob}`, `${file} paths glob \`${glob}\` matches no file`, spec.capability));
}
