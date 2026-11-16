// Request blocking predicates shared by nextStep, plan_units and unit_amend.
// A request blocks when the human must answer before work proceeds.

import type { RequestMode, Subject } from "../interaction/approver.ts";
import type { ChangeState } from "./state-types.ts";

const QUESTION_SUBJECT = "question:";

/**
 * A question request blocks only while its question is blocking in the body (design D4), so a
 * reclassification takes effect at once; other requests keep their stored mode.
 */
export function effectiveMode(state: ChangeState, subject: string, stored: unknown): RequestMode {
	const question = subject.startsWith(QUESTION_SUBJECT)
		? state.change.questions.find((q) => q.id === subject.slice(QUESTION_SUBJECT.length))
		: undefined;
	if (question) return question.kind === "blocking" ? "blocking" : "async";
	// Comment data is untyped at runtime: anything but `async` waits for the human.
	return stored === "async" ? "async" : "blocking";
}

/** Only a question present in the body as non-blocking lets its request wait; everything else blocks. */
function waitsForNobody(state: ChangeState, subject: string): boolean {
	if (!subject.startsWith(QUESTION_SUBJECT)) return false;
	const id = subject.slice(QUESTION_SUBJECT.length);
	return state.change.questions.some((q) => q.id === id && q.kind === "non-blocking");
}

/** Pending requests that block (design D1), then every applying one, in comment order. */
export function blockingRequests(state: ChangeState): { id: string; subject: Subject }[] {
	const pending = state.requests.pending.filter((r) => !waitsForNobody(state, r.subject));
	return [...pending, ...state.requests.applying].map((r) => ({ id: r.id, subject: r.subject }));
}
