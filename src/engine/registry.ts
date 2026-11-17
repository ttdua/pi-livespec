import type { Node } from "yaml";
import type { Change } from "../core/change.ts";
import type { Result } from "../core/result.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { Pack } from "./pack-types.ts";
import type { CheckResult } from "./state-types.ts";

export type SubSchema = {
	validate(node: Node | null, report: (node: Node, message: string) => void): void;
	personas?(value: unknown): string[];
};

export type CheckGit = { diff(from: string, to: string, path: string): Promise<string> };
/** `marked` are the own marked comments of the change issue, in comment order. */
export type CheckContext = { root: string; change: Change; git: CheckGit; marked: MarkedComment[] };
export type CheckFn = (ctx: CheckContext) => Promise<Result[]>;

const schemas = new Map<"decisions" | "subagents", SubSchema>();
const checks = new Map<string, CheckFn>();
const waivable = new Set<string>();
const gateOnly = new Map<string, (ctx: CheckContext) => string | undefined>();
type GateMemo = { key: string; results: CheckResult[] };
/** Last results of gate-only checks by check name; one session, cleared by `clearGateMemo`. */
const gateMemo = new Map<string, GateMemo>();
const memoClearListeners: (() => void)[] = [];
let memoGeneration = 0;

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

/**
 * Registers (or replaces) a check; `waivable` lets a human waive its failure at a human gate.
 * `at: "gate"` makes it gate-only: it runs only when its gate is requested, and `key` says whether
 * its stored results are still valid for the current state (no `key` means they never are).
 */
export function registerCheck(
	name: string,
	fn: CheckFn,
	opts: { waivable?: boolean; at?: "gate"; key?: (ctx: CheckContext) => string } = {},
): void {
	checks.set(name, fn);
	if (opts.waivable === true) waivable.add(name);
	else waivable.delete(name);
	gateOnly.delete(name);
	gateMemo.delete(name);
	if (opts.at === "gate") gateOnly.set(name, opts.key ?? (() => undefined));
}
export function isGateOnly(name: string): boolean {
	return gateOnly.has(name);
}
/** The key of gate-only check `name` for `ctx`; undefined when the check is not gate-only. */
export function gateKey(name: string, ctx: CheckContext): string | undefined {
	return gateOnly.get(name)?.(ctx);
}
export function storeGateResults(name: string, key: string, results: CheckResult[]): void {
	gateMemo.set(name, { key, results });
}
/** The stored results of gate-only check `name` when stored under `key`, else none. */
export function storedGateResults(name: string, key: string | undefined): CheckResult[] {
	const memo = gateMemo.get(name);
	return memo !== undefined && key !== undefined && memo.key === key ? memo.results : [];
}
/** Empties the memo of gate-only results and tells every listener; a new session runs them again. */
export function clearGateMemo(): void {
	gateMemo.clear();
	memoGeneration += 1;
	for (const fn of memoClearListeners) fn();
}
export function gateMemoGeneration(): number {
	return memoGeneration;
}
export function onGateMemoClear(fn: () => void): void {
	memoClearListeners.push(fn);
}
export function isWaivable(name: string): boolean {
	return waivable.has(name);
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
	waivable.clear();
	gateOnly.clear();
	clearGateMemo();
}
