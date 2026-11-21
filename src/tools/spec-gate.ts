// `spec_gate <target>` (design D7): a thin tool over the pure gate planner. It
// refuses through `gateRefusal`, passes a `self` gate by writing the gate
// comment, or sends a `human` gate through the approver chain with the phase's
// review payload and completes the answer. The tool has no answer parameter:
// outcomes come only from an adapter. The phase advance is derived by
// `nextStep` and applied by `Session.refresh`.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { unitDigest } from "../core/digest.ts";
import { runChecks } from "../engine/checks.ts";
import { shipFor } from "../ship/context.ts";
import { collectReviewFacts, gatePayload } from "../engine/gate-payload.ts";
import { failingWaivable, gateRefusal, resolveGateTarget } from "../engine/gates.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { ApprovalRequest, GateSnapshot, RequestOption, Subject } from "../interaction/approver.ts";
import { type GateCommentInput, gateComment } from "../interaction/complete-gate.ts";
import { prepareRequest } from "../interaction/requests.ts";
import { agentSkillsOf } from "../interaction/session-ctx.ts";
import { WAIVE } from "../interaction/waive-rule.ts";
import type { ApproverCtx } from "./approver-for.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { sendRequest, withStep } from "./request-flow.ts";

export type SpecGateParams = { target: string };

const PLAN = "plan";
const BASE36 = 36;
const SELF_BY = "livespec";
const NEW_STUCK_HINT = "An earlier stuck answer that chose no option does not lift the cap: send a new stuck report with spec_stuck.";

// --- pure planning -------------------------------------------------------------------

/** How the target's gate passes: by its checks alone, or through a human. */
export type GatePlan = { mode: "self" | "human"; isPhase: boolean; failingWaivable: string[]; options: RequestOption[] };

/**
 * Plans a gate that `gateRefusal` let through; a self gate never passes with a failing check, waivable or
 * not. A human gate offers `waive` first, then a named gate's own options. A named gate's option choice is
 * not a waive: a named gate with failing waivable checks passes only through `waive`, so the human cannot
 * pick one of its options and waive in the same answer.
 */
export function planGate(state: ChangeState, pack: Pack, target: string): GatePlan | { refused: string } {
	const resolved = resolveGateTarget(state, pack, target);
	if (!resolved) return { refused: `${target} is not a gate.` };
	const waivable = failingWaivable(state, pack, target);
	const isPhase = resolved.kind === "phase";
	if (isPhase && resolved.phase.gate === "self") {
		if (waivable.length > 0) return { refused: `The ${target} gate is self: it cannot pass while ${waivable.join(", ")} fails; fix it first.` };
		return { mode: "self", isPhase, failingWaivable: [], options: [] };
	}
	const named = resolved.kind === "named" ? (resolved.gate.options ?? []) : [];
	const waive = waivable.length > 0 ? [{ id: WAIVE, label: `Waive ${waivable.join(", ")}` }] : [];
	return { mode: "human", isPhase, failingWaivable: waivable, options: [...waive, ...named] };
}

/** The refusal text, with the stuck hint when the iteration cap is what blocks. */
export function refusalText(state: ChangeState, refusal: string): string {
	const it = state.iterations;
	return it.blocking && it.stuckOpen === undefined ? `${refusal} ${NEW_STUCK_HINT}` : refusal;
}

function unitDigests(state: ChangeState): Record<string, string> {
	return Object.fromEntries(state.change.units.map((u) => [u.id, unitDigest(u)]));
}

/** The gate comment of a passing self gate; the plan gate also records the locked digests and the agent-skills commit. */
export function selfGateComment(state: ChangeState, target: string, now: Date, agentSkills: string | undefined): string {
	const input: GateCommentInput = {
		target,
		isPhase: true,
		answer: { outcome: "approved", notes: "", by: SELF_BY, at: now.toISOString(), adapter: SELF_BY },
		headSha: state.git.head,
		waivers: [],
	};
	if (target === PLAN) {
		input.locked = unitDigests(state);
		if (agentSkills !== undefined) input.agentSkills = agentSkills;
	}
	return gateComment(`self-${now.getTime().toString(BASE36)}`, input);
}

/** The prepared envelope of a human gate request, with the review payload. */
export function gateRequest(
	state: ChangeState,
	pack: Pack,
	target: string,
	plan: GatePlan,
	input: { body: string; payload: ReturnType<typeof gatePayload>; now: Date },
): ApprovalRequest {
	const snapshot: GateSnapshot = { target, failingWaivable: plan.failingWaivable, ...(input.payload.findings.length === 0 ? {} : { findings: input.payload.findings }) };
	const subject: Subject = `gate:${target}`;
	const options = plan.options.length > 0 ? { options: plan.options } : {};
	const record = prepareRequest({ kind: "gate", subject, mode: "blocking", ...options, head: state.git.head, body: input.body, snapshot, summary: input.payload.summary, now: input.now });
	const phase = state.phase.kind === "ok" ? state.phase.id : "";
	const request: ApprovalRequest = { id: record.id, kind: "gate", subject, record, change: state.issue.number, phase, summary: record.summary, links: input.payload.links, files: input.payload.files, mode: "blocking", ...options };
	if (target === PLAN) request.overridable = { units: state.change.units.map((u) => u.id) };
	return request;
}

// --- I/O -----------------------------------------------------------------------------

async function passSelf(w: WriteContext, state: ChangeState, target: string): Promise<ToolResult<undefined>> {
	const n = state.issue.number;
	await w.forge.createComment(n, selfGateComment(state, target, new Date(), agentSkillsOf(w.session)));
	await afterForgeWrite(w.session, n);
	return toolResult(withStep(w.session, `The ${target} self gate passed.`), undefined);
}

async function buildRequest(w: WriteContext, state: ChangeState, target: string, plan: GatePlan): Promise<ApprovalRequest> {
	const facts = await collectReviewFacts(w.session.git, state.change.header.base);
	const issue = await w.forge.getIssue(state.issue.number);
	const withLink = issue.url === undefined ? facts : { ...facts, issueUrl: issue.url };
	return gateRequest(state, w.pack, target, plan, { body: issue.body, payload: gatePayload(state, w.pack, target, withLink), now: new Date() });
}

async function askHuman(w: WriteContext, state: ChangeState, target: string, plan: GatePlan, ctx: ApproverCtx): Promise<ToolResult<undefined>> {
	const request = await buildRequest(w, state, target, plan);
	// The waive rule is enforced for every adapter when the answer is validated (`validateAnswer`).
	return sendRequest(w, state, request, ctx, { tool: "spec_gate", retry: "request the gate again" });
}

/** Runs the gate-only checks of `target` before the refusals, so they see the fresh results. */
async function withGateChecks(w: WriteContext, state: ChangeState, target: string): Promise<ChangeState> {
	const ship = await shipFor(w.session, state);
	const checks = await runChecks(w.pack, state, { root: w.session.cwd, git: w.session.git, ...(ship === undefined ? {} : { ship }) }, { gate: true, target });
	return { ...state, checks };
}

export async function runSpecGate(p: SpecGateParams, ctx: ApproverCtx): Promise<ToolResult<undefined>> {
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, undefined, true);
	const change = requireChange(w.session);
	if (!change.ok) return toolResult(change.message, undefined, true);
	const target = String(p.target ?? "");
	const state = await withGateChecks(w, change.state, target);
	const refusal = gateRefusal(state, w.pack, target);
	if (refusal) return toolResult(refusalText(state, refusal), undefined, true);
	const plan = planGate(state, w.pack, target);
	if ("refused" in plan) return toolResult(plan.refused, undefined, true);
	return plan.mode === "self" ? passSelf(w, state, target) : askHuman(w, state, target, plan, ctx);
}

export function registerSpecGate(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: "spec_gate",
		label: "Request a livespec gate",
		description:
			"Request the gate of the current livespec phase, or a registered named gate. A self gate passes when its checks pass; a human gate asks the human through the configured approver chain. The outcome comes only from the human; this tool takes no answer.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. Only `target`: no outcome or choice parameter.
		parameters: {
			type: "object",
			properties: { target: { type: "string", description: "The current phase id, or a registered named gate" } },
			required: ["target"],
		} as never,
		execute: (_id, params, _signal, _update, ctx) => runSpecGate({ target: (params as SpecGateParams).target }, ctx as ApproverCtx),
	});
}
