// `subagent_answer <id> <answer>`: records the answer, resumes the waiting child and handles its next result as a dispatch does.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeState } from "../engine/state-types.ts";
import { cancelledOutcome, type DispatchOutcome, isCancelled, resumedRun, settle } from "../subagents/dispatch.ts";
import { findExecutor, knows, type SubagentsServiceLike } from "../subagents/executor.ts";
import { claim, release, targetKey, update } from "../subagents/in-flight.ts";
import { buildPacket, changeName } from "../subagents/packet.ts";
import { readPacket } from "../subagents/packet-store.ts";
import { dispatchComment, type DispatchQuestionData, isFallbackChild, pendingQuestionOf } from "../subagents/records.ts";
import { resumeChild } from "../subagents/resume.ts";
import type { Packet } from "../subagents/source-types.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { outcomeOptions, outcomeText } from "./subagent-outcome.ts";
import { defaultSubagentDeps, dispatchDeps, dispatchRequest, findingOf, packetContext, type SubagentToolDeps } from "./subagent-request.ts";
import { argsOf, childRefusal, refusal, type Target, type ToolCtx, warn } from "./subagent-target.ts";

const TOOL = "subagent_answer";

export type AnswerParams = { id: string; answer: string };

type Question = Extract<DispatchQuestionData, { status: "QUESTION" }>;

const targetOf = (q: Question): Target => ({ role: q.role, ...(q.unit === undefined ? {} : { unit: q.unit }), ...(q.subject === undefined ? {} : { subject: q.subject }), ...(q.finding === undefined ? {} : { finding: q.finding }) });

/** The packet the child was launched with: the stored one, else a rebuild with the verifier's finding (its hash may differ after new answers). */
async function packetOf(w: WriteContext, state: ChangeState, q: Question): Promise<Packet | string> {
	const found = findingOf(state, targetOf(q));
	if (typeof found === "string") return found;
	const ctx = packetContext(w, state, q.unit, found);
	const stored = q.launch === undefined ? undefined : await readPacket(ctx.root, changeName(ctx), q.launch.packet);
	if (stored !== undefined) return stored;
	const built = await buildPacket(ctx, q.role, q.unit, q.subject);
	return built.ok ? built.packet : built.message;
}

function serviceOf(): SubagentsServiceLike | undefined {
	const found = findExecutor();
	return found.ok ? found.service : undefined;
}

export async function runSubagentAnswer(pi: ExtensionAPI, p: AnswerParams, ctx: ToolCtx, deps: SubagentToolDeps = defaultSubagentDeps, signal?: AbortSignal): Promise<ToolResult<undefined>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return child;
	if (typeof p.answer !== "string" || p.answer.trim() === "") return refusal(TOOL, "the answer is empty.");
	const first = await changeOf(p);
	if ("refusal" in first) return first.refusal;
	const t = targetOf(first.q);
	const key = targetKey(first.state.issue.number, t);
	const running = claim(key);
	if (running !== undefined) return refusal(TOOL, `${argsOf(t)} is already running as child ${running}; wait for it or answer it.`);
	try {
		update(key, p.id);
		// Read again under the claim: a call that finished meanwhile may have answered this question.
		const fresh = await changeOf(p);
		if ("refusal" in fresh) return fresh.refusal;
		const service = serviceOf();
		if (service === undefined) return refusal(TOOL, `no capable subagent executor is present; dispatch ${fresh.q.role} again.`);
		if (!knows(service, p.id)) return refusal(TOOL, `the executor no longer knows child ${p.id}; dispatch ${fresh.q.role} again.`);
		const packet = await packetOf(fresh.w, fresh.state, fresh.q);
		if (typeof packet === "string") return refusal(TOOL, packet);
		return await answerRun({ pi, w: fresh.w, state: fresh.state, service, deps, ctx, signal }, p, fresh.q, packet, key);
	} finally {
		release(key);
	}
}

/** The writable change with the child's pending question, from a refreshed session. */
async function changeOf(p: AnswerParams): Promise<{ w: WriteContext; state: ChangeState; q: Question } | { refusal: ToolResult<undefined> }> {
	const w = await prepareWrite();
	if (!w.ok) return { refusal: refusal(TOOL, w.message) };
	const change = requireChange(w.session);
	if (!change.ok) return { refusal: refusal(TOOL, change.message) };
	const q = pendingQuestionOf(change.state.marked, p.id);
	if (q === undefined) return { refusal: refusal(TOOL, `no child ${p.id} has a pending question in this change.`) };
	return { w, state: change.state, q };
}

type AnswerEnv = { pi: ExtensionAPI; w: WriteContext; state: ChangeState; service: SubagentsServiceLike; deps: SubagentToolDeps; ctx: ToolCtx; signal: AbortSignal | undefined };

/** Records the answer, resumes the child and settles its next result; a fallback respawn moves the claim to the new child. */
async function answerRun(e: AnswerEnv, p: AnswerParams, q: Question, packet: Packet, key: string): Promise<ToolResult<undefined>> {
	const { w, state, signal } = e;
	const t = targetOf(q);
	const request = await dispatchRequest(w, state, t, packet, e.deps);
	const d = { ...dispatchDeps(e.pi, w, state.issue.number, e.service, warn(e.ctx)), onLaunch: (id: string) => update(key, id), ...(signal === undefined ? {} : { signal }) };
	await d.post(dispatchComment({ status: "ANSWERED", role: q.role, ...(q.unit === undefined ? {} : { unit: q.unit }), agentId: p.id, ...(q.attempt === undefined ? {} : { attempt: q.attempt }), answer: p.answer }));
	const record = await resumeChild(d, p.id, p.answer);
	if (isCancelled(signal)) return toolResult(withStep(w.session, outcomeText(t, cancelledOutcome(p.id))), undefined, true);
	if (typeof record === "string") return toolResult(withStep(w.session, `${TOOL} failed: ${record}. the answer is recorded on the forge, but the child did not resume: dispatch ${argsOf(t)} again.`), undefined, true);
	const run = resumedRun(p.id, packet.cwd, q.launch, request.difficulty);
	const outcome: DispatchOutcome = await settle(d, { ...request, attempt: q.attempt ?? request.attempt }, { run, record }, { needsContext: request.needsContext, retries: 0, returns: 0, disputeReturns: 0, respawned: isFallbackChild(state.marked, p.id) });
	return toolResult(withStep(w.session, outcomeText(t, outcome, outcomeOptions(state, w.pack))), undefined, outcome.kind === "cancelled");
}


export function registerSubagentAnswer(pi: ExtensionAPI, deps: SubagentToolDeps = defaultSubagentDeps): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Answer a livespec subagent",
		description:
			"Answer the pending question of a child launched by subagent_dispatch, resume it and record its result. Do not answer what only the user can decide (scope, requirements, public contracts, acceptance criteria): raise those with spec_question first.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: { id: { type: "string", description: "Agent id of the child" }, answer: { type: "string" } }, required: ["id", "answer"] } as never,
		execute: (_id, params, signal, _update, ctx) => runSubagentAnswer(pi, params as AnswerParams, ctx as never, deps, signal),
	});
}
