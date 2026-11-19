// `subagent_dispatch <role> [unit] [subject]`: builds the packet, launches the role's agent, waits and records the interpreted result.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDispatch } from "../subagents/dispatch.ts";
import { findExecutor } from "../subagents/executor.ts";
import { buildPacket, changeName } from "../subagents/packet.ts";
import { writePacket } from "../subagents/packet-store.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { inlineText, outcomeText } from "./subagent-outcome.ts";
import { defaultSubagentDeps, dispatchDeps, dispatchRequest, packetContext, type SubagentToolDeps } from "./subagent-request.ts";
import { checkTarget, childRefusal, refusal, TARGET_PROPERTIES, type TargetParams, type ToolCtx, warn } from "./subagent-target.ts";

const TOOL = "subagent_dispatch";

export async function runSubagentDispatch(pi: ExtensionAPI, p: TargetParams, ctx: ToolCtx, deps: SubagentToolDeps = defaultSubagentDeps): Promise<ToolResult<undefined>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return child;
	const w = await prepareWrite();
	if (!w.ok) return refusal(TOOL, w.message);
	const change = requireChange(w.session);
	if (!change.ok) return refusal(TOOL, change.message);
	const { state } = change;
	const target = checkTarget(p, state);
	if (typeof target === "string") return refusal(TOOL, target);
	const pctx = packetContext(w, state, target.unit);
	const built = await buildPacket(pctx, target.role, target.unit, target.subject);
	if (!built.ok) return refusal(TOOL, built.message);
	const executor = findExecutor();
	if (!executor.ok) return toolResult(inlineText(target, `no capable subagent executor (missing ${executor.missing.join(", ")})`, built.packet), undefined);
	const request = await dispatchRequest(w, state, target, built.packet, deps);
	await writePacket(pctx.root, changeName(pctx), built.packet);
	const outcome = await runDispatch(dispatchDeps(pi, w, state.issue.number, executor.service, warn(ctx)), request);
	return toolResult(withStep(w.session, outcomeText(target, outcome)), undefined);
}

export function registerSubagentDispatch(pi: ExtensionAPI, deps: SubagentToolDeps = defaultSubagentDeps): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Dispatch a livespec subagent",
		description:
			"Launch the role's subagent (scout, implementer, reviewer, verifier) with a livespec packet, wait for it and record its result. A unit id is required for implementer and the unit subject; a reviewer needs a subject. Without a capable executor it returns the packet to run inline.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: TARGET_PROPERTIES, required: ["role"] } as never,
		execute: (_id, params, _signal, _update, ctx) => runSubagentDispatch(pi, params as TargetParams, ctx as never, deps),
	});
}
