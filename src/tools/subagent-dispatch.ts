// `subagent_dispatch <role> [unit] [subject]`: builds the packet, launches the role's agent, waits and records the interpreted result.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type DispatchOutcome, runDispatch } from "../subagents/dispatch.ts";
import { findExecutor } from "../subagents/executor.ts";
import { buildPacket, changeName } from "../subagents/packet.ts";
import { writePacket } from "../subagents/packet-store.ts";
import type { Packet } from "../subagents/source-types.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import {
	argsOf, checkTarget, childRefusal, defaultSubagentDeps, dispatchDeps, dispatchRequest, packetContext, packetText, refusal,
	type SubagentToolDeps, type Target, TARGET_PROPERTIES, type TargetParams, type ToolCtx, warn,
} from "./subagent-env.ts";

const TOOL = "subagent_dispatch";

/** The inline path: the same packet, done in this session, finished with `subagent_record`. */
export function inlineText(t: Target, reason: string, packet: Packet): string {
	const args = argsOf(t);
	return `${t.role} runs inline: ${reason}. Do the work in this session with the packet below, then record the result with subagent_record ${args} (same result shape a child submits).\n\n${packetText(packet)}`;
}

const STATUS_HINT: Partial<Record<string, string>> = {
	NEEDS_CONTEXT: "\nThe child needs more context: add the sources it names (answer a question, amend the unit) and dispatch again; this is not a failed attempt.",
	BLOCKED: "\nThe child is blocked: read its reason and evidence, then send a stuck report with spec_stuck.",
};

/** What the parent reads after a dispatch: the recorded result, the child's question, or the next step. */
export function outcomeText(t: Target, outcome: DispatchOutcome): string {
	switch (outcome.kind) {
		case "result": {
			const r = outcome.result;
			const findings = r.findings === undefined ? "" : `\nFindings: ${r.findings.length}`;
			return `${argsOf(t)} settled with ${r.status} and was recorded.\nNotes: ${r.notes}\nCommits: ${(r.commits ?? []).join(", ") || "none"}\nDiscoveries: ${r.discoveries.join("; ") || "none"}${findings}${STATUS_HINT[r.status] ?? ""}`;
		}
		case "question":
			return `Child ${outcome.id} asks: ${outcome.text}\nAnswer it with subagent_answer ${outcome.id} "<answer>". If only the user can decide (scope, a requirement, a public contract or an acceptance criterion), raise it with spec_question first and answer the child with the user's answer.`;
		case "inline":
			return inlineText(t, outcome.reason, outcome.packet);
		case "sequential":
			return `${outcome.reason}. Close the lane and run ${t.unit} in the change worktree.`;
		case "blocked":
			return `${argsOf(t)} is BLOCKED: ${outcome.reason}. Send a stuck report with spec_stuck.`;
		case "stuck":
			return `${argsOf(t)} needs a decision: ${outcome.reason}. Send a stuck report with spec_stuck for ${t.unit ?? "the change"}.`;
	}
}

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
