// Applying a question answer, in this order, each step skipped when already applied: one body write
// (the answer line), then the `question` result comment. An answer never moves the change (design D8).

import { type Change, parseChange } from "../core/change.ts";
import { answerQuestion } from "../core/question-lines.ts";
import { writeMarked } from "../forge/markers.ts";
import type { Answered, QuestionClass } from "./approver.ts";
import { snapshotOf } from "./requests.ts";
import { type ApplyFn, editBody, readIssue } from "./complete-effects.ts";


function classOf(change: Change, id: string, answer: Answered): QuestionClass {
	return answer.questionClass ?? change.questions.find((q) => q.id === id)?.kind ?? "blocking";
}

/** The answer line, as one body edit. */
function answeredBody(body: string, id: string, answer: Answered): string {
	return answerQuestion(body, id, classOf(parseChange(body), id, answer), answer.answer ?? "");
}

export const applyQuestion: ApplyFn = async (run, record) => {
	const { request, answer } = record;
	const typed = snapshotOf(request);
	if (typed.kind !== "question") throw new Error(`${request.subject} is not a question request`);
	const id = typed.snapshot.id;
	const answered = answer.outcome !== "dismissed";
	if (answered) {
		await editBody(run, (body) => answeredBody(body, id, answer));
	}
	const change = parseChange((await readIssue(run)).body);
	const data: Record<string, unknown> = { request: request.id, class: classOf(change, id, answer), answer: answered ? (answer.answer ?? "") : "" };
	Object.assign(data, { by: answer.by, at: answer.at, adapter: answer.adapter });
	if (answer.answerComment) data.answer_comment = answer.answerComment;
	return { comment: writeMarked("question", `${id}.${request.id}`, data) };
};
