// The drafts of an `initiative` gate request (design D6) and the pure helpers both the proposer and
// the completion use on them: the dependency graph they would produce, the order entries are written
// in, and the review summary.

import { parseChange } from "../core/change.ts";
import type { Initiative } from "../core/initiative.ts";
import type { Issue } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { findCycle, formatCycle } from "./graph.ts";
import { dependencyNumbers } from "./readiness.ts";

/** The name of a new entry of the drafts, or the number of an existing change. */
export type DraftDep = string | number;

/**
 * One entry. `number` is set for an existing change and absent for a change the completion creates.
 * A new entry always has `proposal` and `depends`; an existing one carries only what the request writes.
 * `before` places a new entry right before that existing entry in `## Changes` instead of last.
 */
export type DraftEntry = { name: string; number?: number; proposal?: string; depends?: DraftDep[]; before?: number };

/** `amend` is the tracking issue an amendment edits; `remove` lists the entries it removes from it. */
export type InitiativeDrafts = {
	name: string;
	goal: string;
	capabilities: string[];
	current: number;
	amend?: number;
	entries: DraftEntry[];
	remove?: number[];
};

/** The dependencies an existing change has now: its own `Depends` line united with its initiative entry. */
export function existingDepends(issues: Issue[], initiative?: Initiative): Map<number, number[]> {
	const out = new Map<number, number[]>();
	for (const issue of issues) out.set(issue.number, dependencyNumbers({ issue, change: parseChange(issue.body) }, initiative));
	for (const e of initiative?.changes ?? []) if (!out.has(e.number)) out.set(e.number, [...e.depends]);
	return out;
}

/** The graph the drafts would produce over `existing`: edited entries replace their edges, new ones add a node. */
export function draftGraph(drafts: InitiativeDrafts, existing: Map<number, number[]>): Map<DraftDep, DraftDep[]> {
	const graph = new Map<DraftDep, DraftDep[]>(existing);
	for (const e of drafts.entries) {
		const node = e.number ?? e.name;
		if (e.depends !== undefined) graph.set(node, [...e.depends]);
		else if (!graph.has(node)) graph.set(node, []);
	}
	for (const n of drafts.remove ?? []) graph.delete(n);
	return graph;
}

/** The first cycle the drafts would produce, as `a → b → a`, or undefined. */
export function draftCycle(drafts: InitiativeDrafts, existing: Map<number, number[]>): string | undefined {
	const cycle = findCycle(draftGraph(drafts, existing));
	return cycle === undefined ? undefined : formatCycle(cycle);
}

const nodeOf = (e: DraftEntry): DraftDep => e.number ?? e.name;

/** The entries in dependency order (a dependency among the entries comes first), otherwise in input order. */
export function createOrder(entries: DraftEntry[]): DraftEntry[] {
	const nodes = new Set(entries.map(nodeOf));
	const placed = new Set<DraftDep>();
	const out: DraftEntry[] = [];
	const visit = (e: DraftEntry): void => {
		if (placed.has(nodeOf(e))) return;
		placed.add(nodeOf(e));
		for (const d of e.depends ?? []) {
			const dep = nodes.has(d) ? entries.find((x) => nodeOf(x) === d) : undefined;
			if (dep) visit(dep);
		}
		out.push(e);
	};
	for (const e of entries) visit(e);
	return out;
}

const depText = (d: DraftDep): string => (typeof d === "number" ? `#${d}` : d);

function entryLines(e: DraftEntry): string[] {
	const head = `- ${e.name} (${e.number === undefined ? "new" : `#${e.number}`})`;
	const depends = e.depends === undefined ? "" : ` — Depends: ${e.depends.length === 0 ? "—" : e.depends.map(depText).join(", ")}`;
	const proposal = e.proposal === undefined ? [] : e.proposal.split("\n").map((l) => `  ${l}`);
	return [`${head}${depends}`, ...proposal];
}

/** The review payload of the request: the tracking issue and the entries it writes. */
export function initiativeSummary(d: InitiativeDrafts): string {
	const tracking = d.amend === undefined ? `Initiative ${d.name} (new tracking issue)` : `Amendment of initiative #${d.amend} ${untrusted(d.name)}`;
	const head = d.amend === undefined ? [tracking, `Goal: ${d.goal}`, `Capabilities: [${d.capabilities.join(", ")}]`] : [tracking];
	const removed = (d.remove ?? []).length === 0 ? [] : [`Removed entries: ${(d.remove ?? []).map((n) => `#${n}`).join(", ")}`];
	return [...head, "Changes:", ...d.entries.flatMap(entryLines), ...removed].join("\n");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isDep = (v: unknown): v is DraftDep => typeof v === "string" || typeof v === "number";

function isEntry(v: unknown): v is DraftEntry {
	if (!isObject(v) || typeof v.name !== "string") return false;
	if (v.number !== undefined && typeof v.number !== "number") return false;
	if (v.proposal !== undefined && typeof v.proposal !== "string") return false;
	if (v.before !== undefined && typeof v.before !== "number") return false;
	return v.depends === undefined || (Array.isArray(v.depends) && v.depends.every(isDep));
}

/** Whether a stored snapshot's drafts have the initiative shape; the snapshot is forge text. */
export function isInitiativeDrafts(v: unknown): v is InitiativeDrafts {
	if (!isObject(v) || typeof v.name !== "string" || typeof v.goal !== "string" || typeof v.current !== "number") return false;
	if (!Array.isArray(v.capabilities) || !v.capabilities.every((c) => typeof c === "string")) return false;
	if (v.amend !== undefined && typeof v.amend !== "number") return false;
	if (v.remove !== undefined && !(Array.isArray(v.remove) && v.remove.every((n) => typeof n === "number"))) return false;
	return Array.isArray(v.entries) && v.entries.every(isEntry);
}
