import type { Node } from "yaml";
import type { Change } from "../core/change.ts";
import type { Result } from "../core/result.ts";
import type { Pack } from "./pack-types.ts";

export type SubSchema = {
	validate(node: Node | null, report: (node: Node, message: string) => void): void;
	personas?(value: unknown): string[];
};

export type CheckGit = { diff(from: string, to: string, path: string): Promise<string> };
export type CheckContext = { root: string; change: Change; git: CheckGit };
export type CheckFn = (ctx: CheckContext) => Promise<Result[]>;

const schemas = new Map<"decisions" | "subagents", SubSchema>();
const checks = new Map<string, CheckFn>();

export function registerPackSchema(key: "decisions" | "subagents", schema: SubSchema): void {
	schemas.set(key, schema);
}
export function getPackSchema(key: "decisions" | "subagents"): SubSchema | undefined {
	return schemas.get(key);
}

/** Sorted unique personas from the `decisions` value and every phase's `subagents` list. */
export function personasForPack(pack: Pack): string[] {
	const found = new Set<string>();
	const decisions = schemas.get("decisions")?.personas;
	if (decisions) for (const p of decisions(pack.decisions)) found.add(p);
	const subagents = schemas.get("subagents")?.personas;
	if (subagents) for (const phase of pack.phases) for (const p of subagents(phase.subagents)) found.add(p);
	return [...found].sort();
}

export function registerCheck(name: string, fn: CheckFn): void {
	checks.set(name, fn);
}
export function checkNames(): string[] {
	return [...checks.keys()];
}
export function getCheck(name: string): CheckFn | undefined {
	return checks.get(name);
}
export function resetRegistryForTests(): void {
	schemas.clear();
	checks.clear();
}
