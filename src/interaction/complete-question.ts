// Applying a question answer (design D12), in this order, each step skipped
// when already applied: one body write (answer line plus unticks of the done
// units the changed requirement covers), the `stale` comment with id `Q<n>`,
// the move back to define, and last the `question` result comment.

import { type Change, parseChange } from "../core/change.ts";
import { answerQuestion } from "../core/question-lines.ts";
import { untickUnit } from "../core/tick.ts";
import { advancePhase } from "../engine/advance.ts";
import { deriveLocks } from "../engine/locks.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { PhaseState } from "../engine/state-types.ts";
import { writeMarked } from "../forge/markers.ts";
import type { Answered, QuestionClass } from "./approver.ts";
import { snapshotOf } from "./requests.ts";
import { type ApplyFn, currentPhase, editBody, phasesAfter, postOnce, readIssue, type Run } from "./complete-effects.ts";

const DEFINE = "define";

/** Units whose `Covers` names the requirement. */
function coveringUnits(change: Change, requirement: string): string[] {
	return change.units.filter((u) => u.covers.includes(requirement)).map((u) => u.id);
}

function classOf(change: Change, id: string, answer: Answered): QuestionClass {
	return answer.questionClass ?? change.questions.find((q) => q.id === id)?.kind ?? "blocking";
}

/** The answer line and the unticks of done covering units, as one body edit. */
function answeredBody(body: string, id: string, answer: Answered): string {
	const change = parseChange(body);
	let next = answerQuestion(body, id, classOf(change, id, answer), answer.answer ?? "");
	if (answer.changesRequirement === undefined) return next;
	for (const unit of coveringUnits(change, answer.changesRequirement)) {
		if (change.units.find((u) => u.id === unit)?.done) next = untickUnit(next, unit);
	}
	return next;
}

/**
 * Whether the change must move back to define: it is in a phase after define, or a previous try left
 * it half-moved (define plus the phase it came from).
 */
function needsMoveBack(pack: Pack, phase: PhaseState): boolean {
	const later = phasesAfter(pack, DEFINE);
	if (phase.kind === "ok") return later.includes(phase.id);
	return phase.kind === "ambiguous" && phase.ids.includes(DEFINE) && phase.ids.some((id) => later.includes(id));
}

/** True when the cascade moves the change back from a phase after define and a plan gate was approved. */
function countsAsIteration(run: Run, phase: PhaseState, change: Change): boolean {
	return needsMoveBack(run.ctx.pack, phase) && deriveLocks(change, run.marked).locked !== undefined;
}

async function cascade(run: Run, id: string, requirement: string): Promise<void> {
	const phase = await currentPhase(run);
	const change = parseChange((await readIssue(run)).body);
	const data = {
		reason: id,
		phases: [DEFINE, ...phasesAfter(run.ctx.pack, DEFINE)],
		units: coveringUnits(change, requirement),
		after_plan: countsAsIteration(run, phase, change),
	};
	await postOnce(run, "stale", id, writeMarked("stale", id, data));
	if (!needsMoveBack(run.ctx.pack, phase)) return;
	const moved = await advancePhase(run.ctx.forge, run.ctx.issue, DEFINE, run.ctx.pack);
	if (moved.status === "refused") throw new Error(`cannot move the change back to define: ${moved.reason}`);
}

export const applyQuestion: ApplyFn = async (run, record) => {
	const { request, answer } = record;
	const typed = snapshotOf(request);
	if (typed.kind !== "question") throw new Error(`${request.subject} is not a question request`);
	const id = typed.snapshot.id;
	const answered = answer.outcome !== "dismissed";
	if (answered) {
		await editBody(run, (body) => answeredBody(body, id, answer));
		if (answer.changesRequirement !== undefined) await cascade(run, id, answer.changesRequirement);
	}
	const change = parseChange((await readIssue(run)).body);
	const data: Record<string, unknown> = { request: request.id, class: classOf(change, id, answer), answer: answered ? (answer.answer ?? "") : "" };
	if (answer.changesRequirement !== undefined && answered) data.changes_requirement = answer.changesRequirement;
	Object.assign(data, { by: answer.by, at: answer.at, adapter: answer.adapter });
	if (answer.answerComment) data.answer_comment = answer.answerComment;
	return writeMarked("question", `${id}.${request.id}`, data);
};
