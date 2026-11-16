// Strict display formats for ids read from comment data (unit ids, stuck report
// ids, request subjects and request ids). A value is shown plain only when it
// matches its field's grammar exactly; anything else is wrapped as untrusted.
// Pure.

import { untrusted } from "../hooks/phase-card.ts";

const UNIT_ID = /^U\d+$/;
const QUESTION_ID = /^Q\d+$/;
const TOKEN = /^[a-z0-9-]+$/;
const STUCK_ID = /^S\d+$/;
const SUBJECT = /^(gate:[a-z0-9-]+|amend:\d+|question:Q\d+|stuck:S\d+|decide:[a-z0-9-]+\.[A-Za-z0-9._-]+)$/;
/** `<subject-token>.<base36 ms>`, as `newRequestId` writes it. */
const REQUEST_ID = /^[A-Za-z0-9-]+\.[0-9a-z]+$/;
const LIST_SEPARATOR = ", ";

function shown(format: RegExp, text: string): string {
	return format.test(text) ? text : untrusted(text);
}

export const displayUnitId = (id: string): string => shown(UNIT_ID, id);
export const displayQuestionId = (id: string): string => shown(QUESTION_ID, id);
/** A gate target or check name: plain only when it is a lowercase dash token. */
export const displayToken = (text: string): string => shown(TOKEN, text);
export const displayStuckId = (id: string): string => shown(STUCK_ID, id);
export const displaySubject = (subject: string): string => shown(SUBJECT, subject);
export const displayRequestId = (id: string): string => shown(REQUEST_ID, id);

/** The unit ids as one comma-separated item, or no item for an empty list. */
export function displayUnitList(ids: string[]): string[] {
	return ids.length === 0 ? [] : [ids.map(displayUnitId).join(LIST_SEPARATOR)];
}
