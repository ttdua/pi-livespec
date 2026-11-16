// The completion engine (design D2): validate an answer once, record it as an
// own `answer` comment, run the subject's effects (each skipped when already
// applied), and write the result comment last. A recorded answer is never
// validated again; `finishApplying` finishes every answer left applying.

import { messageOf } from "../core/messages.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { Answered, RequestRecord } from "./approver.ts";
import { applyAmend } from "./complete-amend.ts";
import { applyDecide } from "./complete-decide.ts";
import { type ApplyFn, type CompletionCtx, postComment, type Run, startRun } from "./complete-effects.ts";
import { applyGate } from "./complete-gate.ts";
import { applyQuestion } from "./complete-question.ts";
import { applyStuck } from "./complete-stuck.ts";
import { validateAnswer } from "./complete-validate.ts";
import { type AnswerData, answerComment, readRequests } from "./requests.ts";

export type { CompletionCtx } from "./complete-effects.ts";
export { validateAnswer } from "./complete-validate.ts";

/**
 * `result` is display text; every part that comes from the forge or the human (by, reason, choice, notes,
 * answer, changed requirement) is wrapped as untrusted.
 */
export type Completion = { status: "completed" | "superseded"; result: string };

const APPLY_BY_PREFIX: [prefix: string, apply: ApplyFn][] = [
	["gate:", applyGate],
	["amend:", applyAmend],
	["question:", applyQuestion],
	["stuck:", applyStuck],
	["decide:", applyDecide],
];

function applyFor(subject: string): ApplyFn {
	const found = APPLY_BY_PREFIX.find(([prefix]) => subject.startsWith(prefix));
	if (!found) throw new Error(`no completion for subject ${subject}`);
	return found[1];
}

/** The recorded answer of `id`, when one exists. */
function recordedAnswer(run: Run, id: string): AnswerData | undefined {
	return readRequests(run.marked).applying.find((a) => a.id === id)?.record;
}

const HUMAN_FIELDS: [label: string, key: "answer" | "changesRequirement" | "notes"][] = [
	["Answer", "answer"],
	["Changes requirement", "changesRequirement"],
	["Notes", "notes"],
];

/**
 * The human's own words (question answer, changed requirement, notes), one line each. A recorded answer
 * comes back from comment yaml, so a field that is not a non-empty string is skipped.
 */
function humanLines(answer: Answered): string[] {
	return HUMAN_FIELDS.flatMap(([label, key]) => {
		const value: unknown = answer[key];
		return typeof value === "string" && value !== "" ? [`${label}: ${untrusted(value)}`] : [];
	});
}

function summary(record: AnswerData): Completion {
	const { request, answer } = record;
	if (record.verdict === "superseded") {
		return { status: "superseded", result: `${untrusted(request.subject)}: the answer no longer matches the change (${record.reason ?? "superseded"}); request it again.` };
	}
	const choice = answer.choice === undefined ? "" : ` (choice ${untrusted(answer.choice)})`;
	const head = `${untrusted(request.subject)}: ${answer.outcome}${choice} by ${untrusted(answer.by)} via ${answer.adapter}.`;
	return { status: "completed", result: [head, ...humanLines(answer)].join("\n") };
}

/** Records the validated answer durably, before any effect runs. */
export async function recordAnswer(run: Run, req: RequestRecord, ans: Answered): Promise<AnswerData> {
	const verdict = await validateAnswer(run.ctx, req, ans);
	const record: AnswerData = { request: req, answer: ans, verdict: verdict.verdict };
	if (verdict.verdict === "superseded") record.reason = verdict.reason;
	await postComment(run, answerComment(req.id, record));
	return record;
}

/** Runs the effects of a recorded answer, then writes its result comment last. */
export async function applyAnswer(run: Run, record: AnswerData): Promise<Completion> {
	const result = await applyFor(record.request.subject)(run, record);
	await postComment(run, result);
	return summary(record);
}

/** Completes one answer; an answer already recorded for the request is finished without validation. */
export async function completeAnswer(ctx: CompletionCtx, req: RequestRecord, ans: Answered): Promise<Completion> {
	const run = startRun(ctx);
	const record = recordedAnswer(run, req.id) ?? (await recordAnswer(run, req, ans));
	return applyAnswer(run, record);
}

export type FinishResult = { finished: Completion[]; errors: string[] };

/** Finishes every applying request in comment order; a failure leaves that one applying for the next try. */
export async function finishApplying(ctx: CompletionCtx): Promise<FinishResult> {
	const run = startRun(ctx);
	const out: FinishResult = { finished: [], errors: [] };
	for (const applying of readRequests(run.marked).applying) {
		try {
			out.finished.push(await applyAnswer(run, applying.record));
		} catch (error) {
			out.errors.push(`${applying.subject}: ${messageOf(error)}`);
		}
	}
	return out;
}
