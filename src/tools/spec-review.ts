// `spec_review` (design D1, D2): runs the review round's stages in order, re-reading the change after each,
// until a stage stops the call or the round is routed. Every decision lives in `src/review/`.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { nextStage } from "../review/round.ts";
import { runStage, type StageCtx } from "../review/stages.ts";
import type { ApproverCtx } from "./approver-for.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { defaultSubagentDeps, type SubagentToolDeps } from "./subagent-request.ts";
import { childRefusal, refusal, type ToolCtx } from "./subagent-target.ts";

const TOOL = "spec_review";
/** start, review, aggregate, verify, route, plus one re-check: a correct round never needs more. */
const MAX_STAGES = 6;

type Loop = { lines: string[]; failed: boolean; ended: boolean } | { result: ToolResult<undefined> };

/** Runs stages until one stops the call or the round is routed; `ended` is false when the stage limit cut it short. */
async function runStages(pi: ExtensionAPI, w: WriteContext, ctx: ToolCtx & ApproverCtx, deps: SubagentToolDeps, signal: AbortSignal | undefined, maxStages: number): Promise<Loop> {
	const lines: string[] = [];
	let failed = false;
	for (let i = 0; i < maxStages; i++) {
		const change = requireChange(w.session);
		if (!change.ok) return { result: refusal(TOOL, change.message) };
		const { state } = change;
		const stage = nextStage(state, w.pack);
		if (stage.stage === "refused") {
			if (lines.length === 0) return { result: refusal(TOOL, stage.reason ?? "") };
			lines.push(`Stopped: ${stage.reason ?? ""}`);
			return { lines, failed, ended: true };
		}
		if (stage.stage === "done") {
			lines.push(lines.length === 0 ? "The review round at HEAD is already routed; nothing was written." : "The review round is routed.");
			return { lines, failed, ended: true };
		}
		const c: StageCtx = { pi, w, state, tool: ctx, deps, ...(signal === undefined ? {} : { signal }) };
		const report = await runStage(stage, c);
		lines.push(`[${stage.stage}] ${report.text}`);
		await afterForgeWrite(w.session, state.issue.number);
		if (report.error === true && lines.length === 1) return { result: toolResult(report.text, undefined, true) };
		failed ||= report.error === true;
		if (report.stop) {
			lines.push("Call spec_review again once that is done.");
			return { lines, failed, ended: true };
		}
	}
	return { lines, failed, ended: false };
}

/** `maxStages` is for tests only; the tool always uses `MAX_STAGES`. */
export async function runSpecReview(pi: ExtensionAPI, ctx: ToolCtx & ApproverCtx, deps: SubagentToolDeps = defaultSubagentDeps, signal?: AbortSignal, maxStages = MAX_STAGES): Promise<ToolResult<undefined>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return child;
	const w = await prepareWrite();
	if (!w.ok) return refusal(TOOL, w.message);
	const loop = await runStages(pi, w, ctx, deps, signal, maxStages);
	if ("result" in loop) return loop.result;
	if (!loop.ended) loop.lines.push(`Stopped after ${maxStages} stages; run spec_review again to continue the round.`);
	return toolResult(withStep(w.session, loop.lines.join("\n")), undefined, loop.failed);
}

export function registerSpecReview(pi: ExtensionAPI, deps: SubagentToolDeps = defaultSubagentDeps): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Run a livespec review round",
		description:
			"Run the review phase's round of the whole change in stages: start (every unit's Verify, re-checked tags, standards), reviewers in parallel, aggregate, verifiers, route. Each stage is skipped when its record exists for HEAD, so calling it again resumes the round. Without a capable executor it returns the subagent_packet and subagent_record calls to run inline. Takes no parameters.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: {} } as never,
		execute: (_id, _params, signal, _update, ctx) => runSpecReview(pi, ctx as never, deps, signal),
	});
}
