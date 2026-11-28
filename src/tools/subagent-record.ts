// `subagent_record <role> [unit] [subject] <result>`: records an inline run exactly as a dispatched run is recorded.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanReviewerBehavior, recordReviewerConclusions } from "../docs/behavior-review.ts";
import { buildPacket, changeName } from "../subagents/packet.ts";
import { writePacket } from "../subagents/packet-store.ts";
import { checkSchema, resultSchema, type SubagentResult } from "../subagents/roles.ts";
import { INLINE_SOURCE, recordResult } from "../subagents/run-record.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { disputeMessage, interpret } from "../subagents/result.ts";
import { outcomeOptions, resultText } from "./subagent-outcome.ts";
import { defaultSubagentDeps, dispatchRequest, findingOf, packetContext, recordDeps, type SubagentToolDeps } from "./subagent-request.ts";
import { checkTarget, childRefusal, ignoreInapplicable, PARAMS_BY_ROLE, withWarnings, refusal, TARGET_PROPERTIES, type TargetParams, type ToolCtx } from "./subagent-target.ts";

const TOOL = "subagent_record";

export type RecordParams = TargetParams & { result: unknown };

/** The result in the role's schema; BLOCKED and NEEDS_CONTEXT need a reason and evidence. */
function checkResult(role: Parameters<typeof resultSchema>[0], value: unknown): SubagentResult | string {
	const check = checkSchema(resultSchema(role), value);
	if (!check.ok) return `the result does not match the ${role} schema: ${check.errors.join("; ")}.`;
	const result = value as SubagentResult;
	if ((result.status === "BLOCKED" || result.status === "NEEDS_CONTEXT") && (!result.reason || !result.evidence)) return `a ${result.status} result needs reason and evidence.`;
	return result;
}

export async function runSubagentRecord(p: RecordParams, ctx: ToolCtx, deps: SubagentToolDeps = defaultSubagentDeps): Promise<ToolResult<undefined>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return child;
	const { params, warnings } = ignoreInapplicable(p);
	return withWarnings(warnings, await runSubagentRecordBody(params, ctx, deps));
}

async function runSubagentRecordBody(p: RecordParams, ctx: ToolCtx, deps: SubagentToolDeps = defaultSubagentDeps): Promise<ToolResult<undefined>> {
	const w = await prepareWrite();
	if (!w.ok) return refusal(TOOL, w.message);
	const change = requireChange(w.session);
	if (!change.ok) return refusal(TOOL, change.message);
	const { state } = change;
	const target = checkTarget(p, state);
	if (typeof target === "string") return refusal(TOOL, target);
	const result = checkResult(target.role, p.result);
	if (typeof result === "string") return refusal(TOOL, result);
	const found = findingOf(state, target);
	if (typeof found === "string") return refusal(TOOL, found);
	const pctx = packetContext(w, state, target.unit, found);
	const built = await buildPacket(pctx, target.role, target.unit, target.subject);
	if (!built.ok) return refusal(TOOL, built.message);
	await writePacket(pctx.root, changeName(pctx), built.packet);
	const request = await dispatchRequest(w, state, target, built.packet, deps);
	const run = {
		...target, attempt: request.attempt, round: request.round, packet: built.packet, agentSource: INLINE_SOURCE,
		requested: { thinking: request.difficulty }, effective: {}, advisory: request.entry?.advisory === true, needsContext: request.needsContext,
	};
	// The dispatched rules, with no child to retry or resume: a missing required source is refused so the parent re-records.
	const cleaned = cleanReviewerBehavior(run, result);
	const decision = interpret({ id: "inline", status: "completed", structuredResult: result }, built.packet, target.role, { needsContext: request.needsContext, retries: 0, returns: 0, disputeReturns: 0, respawned: false }, () => cleaned);
	if (decision.kind === "return-behavior") return refusal(TOOL, `${disputeMessage(decision.capabilities)}; add the finding or change the entry, then record again.`);
	if (decision.kind === "return") return refusal(TOOL, `the result omits required sources from sources_used: ${decision.missing.join(", ")}; read them and record again.`);
	const record = recordDeps(w, state.issue.number);
	const kept = await recordResult(record, run, pctx.cwd, cleaned);
	await recordReviewerConclusions(record.post, run, kept, built.packet);
	const named = decision.kind === "more-context" ? decision.ids : undefined;
	const text = resultText(target, kept, named, decision.kind === "stuck" && result.status === "NEEDS_CONTEXT", outcomeOptions(state, w.pack));
	return toolResult(withStep(w.session, `Inline run: ${text}`), undefined);
}

export function registerSubagentRecord(pi: ExtensionAPI, deps: SubagentToolDeps = defaultSubagentDeps): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Record an inline livespec subagent run",
		description:
			"Record the result of a role run inline (after subagent_packet) in the same shape a child submits: status, notes, discoveries, sources_used, optional reason and evidence, commits for implementer, findings for reviewer and verifier." + " " + PARAMS_BY_ROLE,
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: { ...TARGET_PROPERTIES, result: { type: "object" } }, required: ["role", "result"] } as never,
		execute: (_id, params, _signal, _update, ctx) => runSubagentRecord(params as RecordParams, ctx as never, deps),
	});
}
