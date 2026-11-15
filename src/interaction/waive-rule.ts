// The one waive rule of a gate answer (design D7), shared by the forge command
// matcher and answer validation: an approval while waivable checks fail must
// choose `waive`. A plain approve or a named gate's own option never waives.

import type { Outcome } from "./approver.ts";

export const WAIVE = "waive";

/** The failing waivable checks a gate request's snapshot recorded; [] for any other snapshot. */
export function failingWaivableOf(snapshot: unknown): string[] {
	const list = typeof snapshot === "object" && snapshot !== null ? (snapshot as { failingWaivable?: unknown }).failingWaivable : undefined;
	return Array.isArray(list) ? list.map(String) : [];
}

/** Why an answer cannot approve while `failing` checks fail, or undefined when it may. */
export function unwaivedApproval(failing: string[], answer: { outcome: Outcome; choice?: string }): string | undefined {
	const approves = answer.outcome === "approved" || answer.outcome === "approved_with_notes";
	if (!approves || failing.length === 0 || answer.choice === WAIVE) return undefined;
	return `waivable checks fail (${failing.join(", ")}): they must be waived with choose ${WAIVE}`;
}
