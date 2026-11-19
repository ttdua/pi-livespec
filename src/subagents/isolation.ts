// Isolation list: which configured packages a subagent launch must exclude.
// Built-in patterns cover known other flows; the user config adds more.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Packages of other flows, excluded from every launch without configuration. */
export const KNOWN_FLOW_PATTERNS: readonly RegExp[] = [/(^|[:/])obra\/superpowers(@|$)/, /(^|[:/])ttdua\/pi-superspec(@|$)/];

/** Reads `packages` from one settings file. Missing or invalid files yield none. */
async function packagesIn(file: string): Promise<string[]> {
	let doc: unknown;
	try {
		doc = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return [];
	}
	const packages = (doc as { packages?: unknown } | null)?.packages;
	if (!Array.isArray(packages)) return [];
	const sources: string[] = [];
	for (const entry of packages) {
		if (typeof entry === "string") sources.push(entry);
		else if (typeof entry === "object" && entry !== null && typeof (entry as { source?: unknown }).source === "string") {
			sources.push((entry as { source: string }).source);
		}
	}
	return sources;
}

/** Package sources from pi user and project settings. */
export async function configuredPackages(root: string, home: string): Promise<string[]> {
	const user = await packagesIn(join(home, ".pi", "agent", "settings.json"));
	const project = await packagesIn(join(root, ".pi", "settings.json"));
	return [...user, ...project];
}

/** Configured packages matching a known flow, plus `extra`, without duplicates. */
export function excludedPackages(configured: string[], extra: string[]): string[] {
	const known = configured.filter((source) => KNOWN_FLOW_PATTERNS.some((pattern) => pattern.test(source)));
	return [...new Set([...known, ...extra])];
}
