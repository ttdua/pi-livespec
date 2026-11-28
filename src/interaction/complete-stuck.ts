// Applying a stuck answer (design D12): the `stuck` answer comment with id
// `S<n>-answer` is the result comment; no other effect. It records the outcome,
// so a dismissed answer does not lift the iteration cap.

import { writeMarked } from "../forge/markers.ts";
import type { ApplyFn } from "./complete-effects.ts";
import { snapshotOf } from "./requests.ts";

export const applyStuck: ApplyFn = async (_run, record) => {
	const { request, answer } = record;
	const typed = snapshotOf(request);
	if (typed.kind !== "stuck") throw new Error(`${request.subject} is not a stuck request`);
	const id = typed.snapshot.id;
	const data = { request: request.id, outcome: answer.outcome, choice: answer.choice ?? "", notes: answer.notes, by: answer.by, at: answer.at, adapter: answer.adapter };
	return { comment: writeMarked("stuck", `${id}-answer`, data) };
};
