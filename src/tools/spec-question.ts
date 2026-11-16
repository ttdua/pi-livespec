// `spec_question` (design D12, D5): appends `- [ ] Q<n> (<class>): <text>` to
// `## Questions` and sends it through the approver chain, or sends an open
// question again with `reask`. A blocking question is a blocking request, a
// non-blocking one is async. "Answer later" in session rewrites the question as
// non-blocking before the next adapter gets an async request; with no adapter
// left the question stays open. Completion lives in `complete-question.ts`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Change, parseChange, type Question } from "../core/change.ts";
import { appendQuestion, reclassifyQuestion } from "../core/question-lines.ts";
import { parseSpec } from "../core/spec.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { CachedForge } from "../forge/cache.ts";
import { type ApprovalRequest, isSubject, type QuestionClass, type QuestionSnapshot, type Subject } from "../interaction/approver.ts";
import { openRequestFor, prepareRequest } from "../interaction/requests.ts";
import type { ApproverCtx } from "./approver-for.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { sendRequest } from "./request-flow.ts";

export type SpecQuestionParams = { text?: string; class?: QuestionClass; reask?: string };

/** What to send: a new question to append, or an open question to ask again. */
export type QuestionForm = { action: "ask"; text: string; class: QuestionClass } | { action: "reask"; id: string };

const TOOL = "spec_question";
const SUBJECT_PREFIX = "question:";

/** The subject of question `id`; a question id is always `Q<n>`, so anything else is a bug. */
function questionSubject(id: string): Subject {
	const subject = `${SUBJECT_PREFIX}${id}`;
	if (!isSubject(subject)) throw new Error(`not a question id: ${id}`);
	return subject;
}
const SPECS_PATH = "specs";
/** The reclassify write of "answer later": the first try plus one retry after a version conflict. */
const RECLASSIFY_TRIES = 2;
const DEFERRED_TEXT = (id: string) => `${id} is now non-blocking and stays open with no adapter left to ask; send it again later with spec_question { reask: "${id}" }.`;

const refusal = (message: string): { refused: string } => ({ refused: `${TOOL} refused: ${message}` });

/** Thrown by the "answer later" hook when the body changed under the reclassification. */
class ReclassifyConflict extends Error {}

// --- pure planning -------------------------------------------------------------------

/** Exactly one of `text` (one non-empty line, with an optional class) or `reask`. */
export function questionForm(p: SpecQuestionParams): QuestionForm | { refused: string } {
	const text = typeof p.text === "string" ? p.text : undefined;
	const reask = typeof p.reask === "string" && p.reask !== "" ? p.reask : undefined;
	if ((text === undefined) === (reask === undefined)) return refusal("give either text (a new question) or reask (an open question id).");
	if (reask !== undefined) return { action: "reask", id: reask };
	if (/[\r\n]/.test(text!)) return refusal("the question text must be one line.");
	if (text!.trim() === "") return refusal("the question text is empty.");
	const cls: QuestionClass = p.class === "non-blocking" ? "non-blocking" : "blocking";
	return { action: "ask", text: text!.trim(), class: cls };
}


/** The open question that `reask` names. */
export function reaskTarget(change: Change, id: string): Question | { refused: string } {
	const q = change.questions.find((x) => x.id === id);
	if (!q) return refusal(`${id} is not in ## Questions.`);
	if (q.checked) return refusal(`${id} is answered.`);
	return q;
}

/** The capabilities the change declares, new then modified. */
export function declaredCapabilities(change: Change): string[] {
	const caps = change.header.capabilities;
	return caps ? [...caps.new, ...caps.modified] : [];
}

/** `<capability>/Requirement: <name>` for every requirement heading of one living spec. */
export function requirementNames(capability: string, specText: string): string[] {
	return parseSpec(specText, capability).requirements.map((r) => `${capability}/Requirement: ${r.name}`);
}

/** The prepared question request; the mode follows the class. */
export function questionRequest(state: ChangeState, q: { id: string; text: string; class: QuestionClass }, input: { body: string; requirements: string[]; now: Date }): ApprovalRequest {
	const subject = questionSubject(q.id);
	const mode = q.class === "blocking" ? "blocking" : "async";
	const snapshot: QuestionSnapshot = { id: q.id, text: q.text, requirements: input.requirements };
	const summary = `Question ${q.id} (${q.class}) on change #${state.issue.number}: ${q.text}`;
	const record = prepareRequest({ kind: "question", subject, mode, head: state.git.head, body: input.body, snapshot, summary, now: input.now });
	const phase = state.phase.kind === "ok" ? state.phase.id : "";
	return {
		id: record.id,
		kind: "question",
		subject,
		record,
		change: state.issue.number,
		phase,
		summary,
		links: [],
		files: [],
		mode,
		question: { id: q.id, class: q.class, requirements: input.requirements },
	};
}

// --- I/O -----------------------------------------------------------------------------

/** Requirement names from the declared capabilities' living specs; a missing or broken spec adds none. */
async function readRequirements(root: string, change: Change): Promise<string[]> {
	const names: string[] = [];
	for (const capability of declaredCapabilities(change)) {
		try {
			names.push(...requirementNames(capability, await readFile(join(root, SPECS_PATH, capability, "spec.md"), "utf8")));
		} catch {
			// A missing or unparsable spec offers no names; the human can still type one ("other").
		}
	}
	return names;
}

/** Appends the question with one version-checked body write. */
async function appendToBody(forge: CachedForge, n: number, form: Extract<QuestionForm, { action: "ask" }>): Promise<{ id: string; body: string } | { refused: string }> {
	const issue = await forge.getIssue(n);
	const appended = appendQuestion(issue.body, form.class, form.text);
	const written = await forge.updateIssueBody(n, appended.body, issue.version);
	if (written.status === "conflict") return refusal(`the issue changed while the question was written (${written.changed.join(", ") || "unknown fields"}); nothing was written, call it again.`);
	return appended;
}

/** "Answer later": rewrites the question to non-blocking, version-checked, before the next adapter is asked. */
function reclassifyHook(forge: CachedForge, n: number, id: string): () => Promise<void> {
	const attempt = async (): Promise<boolean> => {
		const issue = await forge.getIssue(n);
		const next = reclassifyQuestion(issue.body, id, "non-blocking");
		if (next === issue.body) return true;
		return (await forge.updateIssueBody(n, next, issue.version)).status === "written";
	};
	return async () => {
		// One retry over a fresh read: a concurrent edit elsewhere in the body should not lose the deferral.
		for (let i = 0; i < RECLASSIFY_TRIES; i++) if (await attempt()) return;
		throw new ReclassifyConflict(`the issue changed while ${id} was made non-blocking`);
	};
}

async function resolveQuestion(w: WriteContext, state: ChangeState, form: QuestionForm): Promise<{ id: string; text: string; class: QuestionClass; body: string } | { refused: string }> {
	const n = state.issue.number;
	if (form.action === "ask") {
		const appended = await appendToBody(w.forge, n, form);
		return "refused" in appended ? appended : { id: appended.id, text: form.text, class: form.class, body: appended.body };
	}
	const body = (await w.forge.getIssue(n)).body;
	const q = reaskTarget(parseChange(body), form.id);
	if ("refused" in q) return q;
	return { id: q.id, text: q.text, class: q.kind, body };
}

export async function runSpecQuestion(p: SpecQuestionParams, ctx: ApproverCtx): Promise<ToolResult<undefined>> {
	const form = questionForm(p);
	if ("refused" in form) return toolResult(form.refused, undefined, true);
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, undefined, true);
	const change = requireChange(w.session);
	if (!change.ok) return toolResult(change.message, undefined, true);
	const { state } = change;
	if (form.action === "reask") {
		const open = openRequestFor(state.requests, questionSubject(form.id));
		if (open) return toolResult(refusal(`a request for ${form.id} is pending (${open}): wait for its answer or end it with /livespec dismiss.`).refused, undefined, true);
	}
	const q = await resolveQuestion(w, state, form);
	if ("refused" in q) return toolResult(q.refused, undefined, true);
	const requirements = await readRequirements(w.session.cwd, parseChange(q.body));
	const request = questionRequest(state, q, { body: q.body, requirements, now: new Date() });
	let result: ToolResult<undefined>;
	try {
		result = await sendRequest(w, state, request, ctx, {
			tool: TOOL,
			retry: `call spec_question { reask: "${q.id}" }`,
			deferred: { hook: reclassifyHook(w.forge, state.issue.number, q.id), text: DEFERRED_TEXT(q.id) },
		});
	} catch (error) {
		if (!(error instanceof ReclassifyConflict)) throw error;
		result = toolResult(`${TOOL}: ${error.message}`, undefined, true);
	}
	return form.action === "ask" && result.isError ? notSent(q.id, result) : result;
}

/** A new question was appended but not sent: name it, so a retry asks it again instead of adding another. */
export function notSent(id: string, result: ToolResult<undefined>): ToolResult<undefined> {
	const reason = result.content.map((c) => c.text).join("\n").replace(/[.\s]+$/, "");
	return toolResult(`${id} was added to ## Questions but not sent: ${reason}; send it with spec_question { reask: "${id}" }.`, undefined, true);
}

export function registerSpecQuestion(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: "spec_question",
		label: "Ask a livespec question",
		description:
			"Ask the human one question about the current livespec change. { text } appends `- [ ] Q<n> (<class>): <text>` to ## Questions (blocking by default; propose class non-blocking when the work can go on) and sends it through the approver chain. { reask: \"Q<n>\" } sends an open question again. The answer comes only from the human; this tool takes no answer.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No answer parameter.
		parameters: {
			type: "object",
			properties: {
				text: { type: "string", description: "The question, on one line" },
				class: { type: "string", enum: ["blocking", "non-blocking"], description: "Proposed class; blocking by default" },
				reask: { type: "string", description: "An open question id (Q<n>) to send again" },
			},
		} as never,
		execute: (_id, params, _signal, _update, ctx) => {
			const q = params as SpecQuestionParams;
			return runSpecQuestion({ text: q.text, class: q.class, reask: q.reask } as SpecQuestionParams, ctx as ApproverCtx);
		},
	});
}
