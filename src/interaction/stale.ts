// The `stale` marker writer (design D2): lists the phases whose gate results
// no longer count and, optionally, the units to re-approve.

import { writeMarked } from "../forge/markers.ts";

/**
 * A `stale` comment that is not an iteration (`after_plan: false`); `units` defaults to none.
 * Key order is fixed so the same input always writes the same bytes.
 */
export function staleComment(id: string, data: { reason: string; phases: string[]; units?: string[] }): string {
	return writeMarked("stale", id, { reason: data.reason, phases: data.phases, units: data.units ?? [], after_plan: false });
}
