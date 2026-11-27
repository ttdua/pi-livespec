// Loop counters: own marked comments of kind `counter`, id `<loop>` or
// `<loop>.<unit>`, data `{ value }`.

import { type MarkedComment, writeMarked } from "../forge/markers.ts";
import type { Forge } from "../forge/types.ts";

export const COUNTER_KIND = "counter";
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

/**
 * Sets counter `id` on issue `n`. `marked` are the caller's own marked comments: an existing counter
 * comment is edited in place (own-marker edit), otherwise a new one is created.
 */
export async function setCounter(forge: Forge, n: number, id: string, value: number, marked: MarkedComment[]): Promise<void> {
	const body = writeMarked(COUNTER_KIND, id, { value });
	const existing = marked.filter((m) => m.kind === COUNTER_KIND && m.id === id).pop();
	if (!existing) {
		await forge.createComment(n, body);
		return;
	}
	// The edit needs the comment's current version, which MarkedComment does not carry.
	const current = (await forge.listComments(n)).find((c) => c.id === existing.ref);
	if (!current) throw new Error(`counter comment ${existing.ref} for ${id} no longer exists on issue #${n}`);
	const result = await forge.updateComment(current.id, body, current.version);
	if (result.status === "conflict") {
		throw new Error(`counter ${id} on issue #${n} changed concurrently (${result.changed.join(", ")})`);
	}
}
