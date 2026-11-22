// Dependency graph over issue numbers (or entry names), with cycle detection.

import type { Initiative } from "../core/initiative.ts";

export type DepGraph = Map<number, number[]>;

/** Unions each change's own `Depends:` line with its initiative entry's dependencies. */
export function dependencyGraph(changes: { number: number; depends: number[] }[], initiative?: Initiative): DepGraph {
	const graph: DepGraph = new Map();
	const add = (n: number, deps: number[]): void => {
		const merged = graph.get(n) ?? [];
		for (const d of deps) if (!merged.includes(d)) merged.push(d);
		graph.set(n, merged);
	};
	for (const c of changes) add(c.number, c.depends);
	for (const e of initiative?.changes ?? []) add(e.number, e.depends);
	return graph;
}

/** The first cycle in insertion order as `[a, b, …, a]`, or undefined. */
export function findCycle<K>(graph: Map<K, K[]>): K[] | undefined {
	const done = new Set<K>();
	const path: K[] = [];
	const visit = (node: K): K[] | undefined => {
		const at = path.indexOf(node);
		if (at !== -1) return [...path.slice(at), node];
		if (done.has(node)) return undefined;
		path.push(node);
		for (const next of graph.get(node) ?? []) {
			const found = visit(next);
			if (found) return found;
		}
		path.pop();
		done.add(node);
		return undefined;
	};
	for (const start of graph.keys()) {
		const found = visit(start);
		if (found) return found;
	}
	return undefined;
}

export function formatCycle(cycle: (number | string)[]): string {
	return cycle.map((n) => (typeof n === "number" ? `#${n}` : n)).join(" → ");
}
