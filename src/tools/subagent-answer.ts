// `subagent_answer <id> <answer>`: records the answer, resumes the waiting child and handles its next result as a dispatch does.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeState } from "../engine/state-types.ts";
import { type DispatchOutcome, resumedRun, settle } from "../subagents/dispatch.ts";
import { findExecutor, type RecordLike, type SubagentsServiceLike } from "../subagents/executor.ts";
import { buildPacket, changeName } from "../subagents/packet.ts";
import { readPacket } from "../subagents/packet-store.ts";
import { dispatchComment, type DispatchQuestionData, pendingQuestionOf } from "../subagents/records.ts";
import type { Packet } from "../subagents/source-types.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { outcomeText } from "./subagent-outcome.ts";
import { defaultSubagentDeps, dispatchDeps, dispatchRequest, packetContext, type SubagentToolDeps } from "./subagent-request.ts";
import { argsOf, childRefusal, refusal, type Target, type ToolCtx, warn } from "./subagent-target.ts";

const TOOL = "subagent_answer";

export type AnswerParams = { id: string; answer: string };

type Question = Extract<DispatchQuestionData, { status: "QUESTION" }>;

const targetOf = (q: Question): Target => ({ role: q.role, ...(q.unit === undefined ? {} : { unit: q.unit }), ...(q.subject === undefined ? {} : { subject: q.subject }) });

/** The packet the child was launched with: the stored one, else a rebuild (its hash may differ after new answers). */
async function packetOf(w: WriteContext, state: ChangeState, q: Question): Promise<Packet | string> {
	const ctx = packetContext(w, state, q.unit);
	const stored = q.launch === undefined ? undefined : await readPacket(ctx.root, changeName(ctx), q.launch.packet);
	if (stored !== undefined) return stored;
	const built = await buildPacket(ctx, q.role, q.unit, q.subject);
	return built.ok ? built.packet : built.message;
}

/** Resumes the child with the answer; a refusal or an unknown id is the reason to dispatch again. */
async function resume(service: SubagentsServiceLike, id: string, answer: string): Promise<RecordLike | string> {
	try {
		const resumed = (await service.resume(id, answer)) as { kind?: string; reason?: string } | undefined;
		if (resumed?.kind === "refused") return `the executor refused to resume ${id} (${resumed.reason ?? "no reason"})`;
		return await service.wait(id);
	} catch (error) {
		return `the executor could not resume ${id}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/** `getRecord` is optional in the contract: without it, an unknown id surfaces as a resume failure. */
function knows(service: SubagentsServiceLike, id: string): boolean {
	const getRecord = (service as { getRecord?: unknown }).getRecord;
	return typeof getRecord !== "function" || getRecord.call(service, id) !== undefined;
}

function serviceOf(): SubagentsServiceLike | undefined {
	const found = findExecutor();
	return found.ok ? found.service : undefined;
}

export async function runSubagentAnswer(pi: ExtensionAPI, p: AnswerParams, ctx: ToolCtx, deps: SubagentToolDeps = defaultSubagentDeps): Promise<ToolResult<undefined>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return child;
	if (typeof p.answer !== "string" || p.answer.trim() === "") return refusal(TOOL, "the answer is empty.");
	const w = await prepareWrite();
	if (!w.ok) return refusal(TOOL, w.message);
	const change = requireChange(w.session);
	if (!change.ok) return refusal(TOOL, change.message);
	const { state } = change;
	const q = pendingQuestionOf(state.marked, p.id);
	if (q === undefined) return refusal(TOOL, `no child ${p.id} has a pending question in this change.`);
	const service = serviceOf();
	if (service === undefined) return refusal(TOOL, `no capable subagent executor is present; dispatch ${q.role} again.`);
	if (!knows(service, p.id)) return refusal(TOOL, `the executor no longer knows child ${p.id}; dispatch ${q.role} again.`);
	const packet = await packetOf(w, state, q);
	if (typeof packet === "string") return refusal(TOOL, packet);
	const t = targetOf(q);
	const request = await dispatchRequest(w, state, t, packet, deps);
	const d = dispatchDeps(pi, w, state.issue.number, service, warn(ctx));
	await d.post(dispatchComment({ status: "ANSWERED", role: q.role, ...(q.unit === undefined ? {} : { unit: q.unit }), agentId: p.id, ...(q.attempt === undefined ? {} : { attempt: q.attempt }), answer: p.answer }));
	const record = await resume(service, p.id, p.answer);
	if (typeof record === "string") return toolResult(withStep(w.session, `${TOOL} failed: ${record}. the answer is recorded on the forge, but the child did not resume: dispatch ${argsOf(t)} again.`), undefined, true);
	const run = resumedRun(p.id, packet.cwd, q.launch, request.difficulty);
	const outcome: DispatchOutcome = await settle(d, { ...request, attempt: q.attempt ?? request.attempt }, { run, record }, { needsContext: request.needsContext, retries: 0, returns: 0 });
	return toolResult(withStep(w.session, outcomeText(t, outcome)), undefined);
}

export function registerSubagentAnswer(pi: ExtensionAPI, deps: SubagentToolDeps = defaultSubagentDeps): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Answer a livespec subagent",
		description:
			"Answer the pending question of a child launched by subagent_dispatch, resume it and record its result. Do not answer what only the user can decide (scope, requirements, public contracts, acceptance criteria): raise those with spec_question first.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: { id: { type: "string", description: "Agent id of the child" }, answer: { type: "string" } }, required: ["id", "answer"] } as never,
		execute: (_id, params, _signal, _update, ctx) => runSubagentAnswer(pi, params as AnswerParams, ctx as never, deps),
	});
}
