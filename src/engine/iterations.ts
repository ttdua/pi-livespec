// `change_iterations` and the iteration-cap predicate (design D12), derived
// purely from own `stale` and `stuck` comments in comment (time) order.

import type { MarkedComment } from "../forge/markers.ts";

export type IterationState = { count: number; cap: number | undefined; blocking: boolean; stuckOpen: string | undefined };

const STALE_KIND = "stale";
const STUCK_KIND = "stuck";
const ANSWER_SUFFIX = "-answer";
const REPORT_ID = /^S\d+$/;

const isCountedCascade = (m: MarkedComment): boolean =>
	m.kind === STALE_KIND && typeof m.data === "object" && m.data !== null && (m.data as { after_plan?: unknown }).after_plan === true;
const isStuckAnswer = (m: MarkedComment): boolean => m.kind === STUCK_KIND && m.id.endsWith(ANSWER_SUFFIX);
const isStuckReport = (m: MarkedComment): boolean => m.kind === STUCK_KIND && REPORT_ID.test(m.id);

/** The latest stuck report with no `<id>-answer` comment, if any. */
function openStuckReport(marked: MarkedComment[]): string | undefined {
	const answered = new Set(marked.filter(isStuckAnswer).map((m) => m.id.slice(0, -ANSWER_SUFFIX.length)));
	return marked
		.filter(isStuckReport)
		.map((m) => m.id)
		.filter((id) => !answered.has(id))
		.pop();
}

/**
 * The count is the number of own `stale` comments with `after_plan: true`. The cap blocks when the
 * count reaches it and no stuck answer follows the latest counted cascade.
 */
export function deriveIterations(marked: MarkedComment[], cap?: number): IterationState {
	const counted = marked.flatMap((m, i) => (isCountedCascade(m) ? [i] : []));
	const lastCounted = counted.at(-1) ?? -1;
	const answeredAfter = marked.some((m, i) => i > lastCounted && isStuckAnswer(m));
	const count = counted.length;
	const blocking = cap !== undefined && count >= cap && !answeredAfter;
	return { count, cap, blocking, stuckOpen: openStuckReport(marked) };
}
