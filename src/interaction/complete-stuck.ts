// Applying a stuck answer (design D12): the `stuck` answer comment with id
// `S<n>-answer` is the result comment; no other effect.

import { writeMarked } from "../forge/markers.ts";
import type { StuckSnapshot } from "./approver.ts";
import type { ApplyFn } from "./complete-effects.ts";

export const applyStuck: ApplyFn = async (_run, record) => {
	const { request, answer } = record;
	const id = (request.snapshot as StuckSnapshot).id;
	const data = { request: request.id, choice: answer.choice ?? "", notes: answer.notes, by: answer.by, at: answer.at, adapter: answer.adapter };
	return writeMarked("stuck", `${id}-answer`, data);
};
