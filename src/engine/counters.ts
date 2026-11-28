// Loop counters: own `counter` ledger entries, id `<loop>` or
// `<loop>.<unit>`, data `{ value }`.

import type { MarkedComment } from "../forge/markers.ts";
import type { Ledger } from "../ledger/index.ts";

export const COUNTER_KIND = "counter" as const;
/**
 * Derived from own `stale` comments (src/engine/iterations.ts), aggregate review records (src/review/status.ts)
 * and `new-dependency` gate results (src/engine/deps-facts.ts); a counter comment for them is ignored.
 */
const DERIVED_COUNTERS = new Set(["change_iterations", "review_rounds", "discovered_deps"]);
/** Derived from `progress` decision records (src/evidence/unit-state.ts); a counter comment for it is ignored. */
const DERIVED_PREFIX = "unit_attempts.";

function counterValue(data: unknown): number | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const value = (data as { value?: unknown }).value;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Counter values by id from own marked comments; malformed data and derived counters are skipped.
 * The last comment for an id wins.
 */
export function readCounters(marked: MarkedComment[]): Record<string, number> {
	const counters: Record<string, number> = {};
	for (const m of marked) {
		if (m.kind !== COUNTER_KIND || DERIVED_COUNTERS.has(m.id) || m.id.startsWith(DERIVED_PREFIX)) continue;
		const value = counterValue(m.data);
		if (value !== undefined) counters[m.id] = value;
	}
	return counters;
}

/** Sets counter `id` on issue `n` by appending a `counter` entry; the latest entry wins on read, the earlier ones stay. */
export async function setCounter(ledger: Ledger, n: number, id: string, value: number, after?: string): Promise<void> {
	await ledger.append(n, { kind: COUNTER_KIND, id, data: { value }, ...(after === undefined ? {} : { after }) });
}
