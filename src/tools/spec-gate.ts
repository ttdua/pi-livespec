// `spec_gate <target>` (design D7): a thin tool over the pure gate planner. It
// refuses through `gateRefusal`, passes a `self` gate by writing the gate
// comment, or sends a `human` gate through the approver chain with the phase's
// review payload and completes the answer. The tool has no answer parameter:
// outcomes come only from an adapter. The phase advance is derived by
// `nextStep` and applied by `Session.refresh`.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isDifficulty } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import { runChecks } from "../engine/checks.ts";
import { shipFor } from "../ship/context.ts";
import { collectReviewFacts, gatePayload } from "../engine/gate-payload.ts";
import { failingWaivable, gateRefusal, namedGate, resolveGateTarget } from "../engine/gates.ts";
import type { Pack } from "../engine/pack-types.ts";
import { type RequirementRecord, requirementRecord } from "../engine/requirement-diff.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { ApprovalRequest, Briefing, GateSnapshot, RequestOption, Subject } from "../interaction/approver.ts";
import { validateBriefing } from "../interaction/briefing.ts";
import { offeredChoiceIds } from "../interaction/describe-actions.ts";
import { type GateCommentInput, gateComment } from "../interaction/complete-gate.ts";
import { prepareRequest } from "../interaction/requests.ts";
import { runSpecCascade } from "../interaction/spec-cascade.ts";
import { agentSkillsOf } from "../interaction/session-ctx.ts";
import { askBehaviorChanges } from "../docs/behavior-ask.ts";
import { WAIVE } from "../interaction/waive-rule.ts";
import type { ApproverCtx } from "./approver-for.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { sendRequest, withStep } from "./request-flow.ts";

export type SpecGateParams = { target: string; briefing?: unknown };

const PLAN = "plan";
const BEHAVIOR_CHECK = "behavior-change";
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

/** The refusal for a recommendation the plan cannot honour: `approve` while a check must be waived, or an id not offered. */
export function recommendationRefusal(b: Briefing | undefined, plan: GatePlan): string | undefined {
	const recommended = b?.recommended;
	if (recommended === undefined) return undefined;
	if (recommended === "approve" && plan.failingWaivable.length > 0) {
		return `briefing.recommended cannot be approve while ${plan.failingWaivable.join(", ")} fails: recommend waive or another action.`;
	}
	const offered = offeredChoiceIds({ kind: "gate", options: plan.options, failingWaivable: plan.failingWaivable });
	return offered.includes(recommended) ? undefined : `briefing.recommended must be one of the offered choices: ${offered.join(", ")}`;
}

function unitDigests(state: ChangeState): Record<string, string> {
	return Object.fromEntries(state.change.units.map((u) => [u.id, unitDigest(u)]));
}

/** The gate comment of a passing self gate; the plan gate also records the locked digests and the agent-skills commit. */
export function selfGateComment(state: ChangeState, target: string, now: Date, agentSkills: string | undefined, record?: RequirementRecord): string {
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
		if (record !== undefined) {
			input.requirements = record.requirements;
			input.requirementScope = record.scope;
		}
	}
	return gateComment(`self-${now.getTime().toString(BASE36)}`, input);
}

/** The Difficulty and Tags each unit has now, for the dialog's Adjust units tab. */
function currentValues(state: ChangeState): NonNullable<ApprovalRequest["overridable"]>["current"] {
	return Object.fromEntries(
		state.change.units.map((u) => [u.id, { ...(isDifficulty(u.difficulty) ? { difficulty: u.difficulty } : {}), tags: u.tags ?? [] }]),
	);
}

/** The prepared envelope of a human gate request, with the review payload. */
export function gateRequest(
	state: ChangeState,
	pack: Pack,
	target: string,
	plan: GatePlan,
	input: { body: string; payload: ReturnType<typeof gatePayload>; now: Date; drafts?: unknown; briefing?: Briefing; requirements?: RequirementRecord },
): ApprovalRequest {
	const snapshot: GateSnapshot = {
		target,
		failingWaivable: plan.failingWaivable,
		...(input.payload.findings.length === 0 ? {} : { findings: input.payload.findings }),
		...(input.drafts === undefined ? {} : { drafts: input.drafts }),
		...(input.requirements === undefined ? {} : { requirements: input.requirements.requirements, requirement_scope: input.requirements.scope }),
	};
	const subject: Subject = `gate:${target}`;
	const options = plan.options.length > 0 ? { options: plan.options } : {};
	const briefing = input.briefing === undefined ? {} : { briefing: input.briefing };
	const record = prepareRequest({ kind: "gate", subject, mode: "blocking", ...options, ...briefing, head: state.git.head, body: input.body, snapshot, summary: input.payload.summary, now: input.now });
	const phase = state.phase.kind === "ok" ? state.phase.id : "";
	const request: ApprovalRequest = { id: record.id, kind: "gate", subject, record, change: state.issue.number, phase, summary: record.summary, links: input.payload.links, files: input.payload.files, mode: "blocking", ...options, ...briefing };
	if (target === PLAN) request.overridable = { units: state.change.units.map((u) => u.id), current: currentValues(state) };
	return request;
}

// --- I/O -----------------------------------------------------------------------------

async function passSelf(w: WriteContext, state: ChangeState, target: string): Promise<ToolResult<undefined>> {
	const n = state.issue.number;
	const record = await planRecord(w, state, target);
	await w.forge.createComment(n, selfGateComment(state, target, new Date(), agentSkillsOf(w.session), record));
	await afterForgeWrite(w.session, n);
	return toolResult(withStep(w.session, `The ${target} self gate passed.`), undefined);
}

/**
 * The plan gate's requirement baseline at `state.git.head`, the HEAD the request binds as `head_sha` (or the
 * self gate records), so the approved record matches what was reviewed; undefined for every other target.
 */
function planRecord(w: WriteContext, state: ChangeState, target: string): Promise<RequirementRecord | undefined> {
	return target === PLAN ? requirementRecord(w.session.git, state.git.head, state.change) : Promise.resolve(undefined);
}

type RequestExtras = { drafts?: unknown; summary?: string; briefing?: Briefing };

async function buildRequest(w: WriteContext, state: ChangeState, target: string, plan: GatePlan, extras: RequestExtras = {}): Promise<ApprovalRequest> {
	const facts = await collectReviewFacts(w.session.git, state.change.header.base);
	const issue = await w.forge.getIssue(state.issue.number);
	const withLink = issue.url === undefined ? facts : { ...facts, issueUrl: issue.url };
	const payload = gatePayload(state, w.pack, target, withLink);
	const summary = extras.summary === undefined ? payload.summary : `${payload.summary}\n\n${extras.summary}`;
	const requirements = await planRecord(w, state, target);
	return gateRequest(state, w.pack, target, plan, { body: issue.body, payload: { ...payload, summary }, now: new Date(), drafts: extras.drafts, briefing: extras.briefing, requirements });
}

async function askHuman(w: WriteContext, state: ChangeState, target: string, plan: GatePlan, ctx: ApproverCtx, briefing: Briefing | undefined): Promise<ToolResult<undefined>> {
	const request = await buildRequest(w, state, target, plan, { briefing });
	// The waive rule is enforced for every adapter when the answer is validated (`validateAnswer`).
	return sendRequest(w, state, request, ctx, { tool: "spec_gate", retry: "request the gate again" });
}

/** Runs the gate-only checks of `target` before the refusals, so they see the fresh results. */
async function withGateChecks(w: WriteContext, state: ChangeState, target: string): Promise<ChangeState> {
	const ship = await shipFor(w.session, state);
	const checks = await runChecks(w.pack, state, { root: w.session.cwd, git: w.session.git, ...(ship === undefined ? {} : { ship }) }, { gate: true, target });
	return { ...state, checks };
}

export type NamedGateInput = { target: string; options: RequestOption[]; drafts: unknown; summary: string; ctx: ApproverCtx; tool: string; briefing?: Briefing };

/**
 * Sends the request of a named gate with a proposer: the proposer's drafts go into the snapshot, its
 * `summary` follows the gate payload, and `options` (a subset of the gate's) replace the gate's own.
 * The refusals hold except the dirty tree, since a proposer gate is not bound to HEAD (design D4).
 */
export async function sendNamedGate(w: WriteContext, state: ChangeState, i: NamedGateInput): Promise<ToolResult<undefined>> {
	const checked = await withGateChecks(w, state, i.target);
	const refusal = gateRefusal(checked, w.pack, i.target, undefined, { proposer: true });
	if (refusal) return toolResult(refusalText(checked, refusal), undefined, true);
	const plan = planGate(checked, w.pack, i.target);
	if ("refused" in plan) return toolResult(plan.refused, undefined, true);
	const waive = plan.options.filter((o) => o.id === WAIVE);
	const offered = { ...plan, options: [...waive, ...i.options] };
	const unrecommendable = recommendationRefusal(i.briefing, offered);
	if (unrecommendable) return toolResult(unrecommendable, undefined, true);
	const request = await buildRequest(w, checked, i.target, offered, { drafts: i.drafts, summary: i.summary, briefing: i.briefing });
	return sendRequest(w, checked, request, i.ctx, { tool: i.tool, retry: `run ${i.tool} again` });
}

/** The phases whose gate asks the behavior question, when the phase lists the `behavior-change` check. */
const BEHAVIOR_TARGETS = new Set(["define", "review"]);

function asksBehavior(pack: Pack, target: string): boolean {
	return BEHAVIOR_TARGETS.has(target) && (pack.phases.find((ph) => ph.id === target)?.checks.includes(BEHAVIOR_CHECK) ?? false);
}

/**
 * The one exception to "refuse, writing nothing" (phase-gates "Gate tool"): the refusals are evaluated with the
 * `behavior-change` results left out, and only when none applies the unanswered items are asked. After an
 * answer the state is re-read and `checked` is false, so the caller's full check run sees the new records.
 */
type BehaviorStep = { ok: true; state: ChangeState; checked: boolean } | { ok: false; message: string };

async function behaviorStep(w: WriteContext, state: ChangeState, target: string, ctx: ApproverCtx): Promise<BehaviorStep> {
	const checked = await withGateChecks(w, state, target);
	const others = { ...checked, checks: checked.checks.filter((c) => c.check !== BEHAVIOR_CHECK) };
	const refusal = gateRefusal(others, w.pack, target);
	if (refusal) return { ok: false, message: refusalText(others, refusal) };
	const asked = await askBehaviorChanges(w, state, ctx);
	if (!asked.ok) return asked;
	// Nothing asked: the checks already ran on this state, `behavior-change` included.
	if (!asked.asked) return { ok: true, state: checked, checked: true };
	await afterForgeWrite(w.session, state.issue.number);
	const fresh = requireChange(w.session);
	return fresh.ok ? { ok: true, state: fresh.state, checked: false } : { ok: false, message: fresh.message };
}

/** `spec_gate` cannot send a gate whose proposer builds the request with its drafts. */
function proposerRefusal(target: string): string | undefined {
	const proposer = namedGate(target)?.proposer;
	return proposer === undefined ? undefined : `The ${target} gate is requested by ${proposer}, which sends it with its drafts: run ${proposer} instead.`;
}

const BRIEFING_REQUIRED = "A human gate needs an agent briefing: pass `briefing` with a `summary` (required: what the human is deciding and what changed), and optionally `watch`, `recommended` and `rationale`.";
const BUILT_IN_IDS = ["approve", "changes", "dismiss", WAIVE];

type BriefingStep = { ok: true; briefing?: Briefing } | { ok: false; message: string };

/** The shape of the briefing a proposer tool passes, against the ids its gate could offer; refuses a bad shape. */
export function proposerBriefing(raw: unknown, options: RequestOption[]): BriefingStep {
	if (raw === undefined) return { ok: true };
	const ids = offeredChoiceIds({ kind: "gate", options: [{ id: WAIVE, label: "Waive" }, ...options] });
	const checked = validateBriefing(raw, ids, { author: "agent" });
	return "refused" in checked ? { ok: false, message: checked.refused } : { ok: true, briefing: checked };
}

/** Requires and validates the briefing of a human gate (a self gate ignores it); runs before any check. */
export function briefingStep(target: string, pack: Pack, raw: unknown): BriefingStep {
	const phase = pack.phases.find((ph) => ph.id === target);
	const named = phase === undefined ? namedGate(target) : undefined;
	const human = phase === undefined ? named !== undefined : phase.gate === "human";
	if (!human) return { ok: true };
	if (raw === undefined) return { ok: false, message: BRIEFING_REQUIRED };
	const ids = [...BUILT_IN_IDS, ...(named?.options ?? []).map((o) => o.id)];
	const checked = validateBriefing(raw, ids, { author: "agent" });
	return "refused" in checked ? { ok: false, message: `${checked.refused}. ${BRIEFING_REQUIRED}` } : { ok: true, briefing: checked };
}

export async function runSpecGate(p: SpecGateParams, ctx: ApproverCtx): Promise<ToolResult<undefined>> {
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, undefined, true);
	// Before the change is resolved, so a cascade that moved the phase back is what the gate sees (design D7).
	await runSpecCascade(w.session);
	const change = requireChange(w.session);
	if (!change.ok) return toolResult(change.message, undefined, true);
	const target = String(p.target ?? "");
	const isPhase = w.pack.phases.some((ph) => ph.id === target);
	const byProposer = isPhase ? undefined : proposerRefusal(target);
	if (byProposer) return toolResult(byProposer, undefined, true);
	const briefed = briefingStep(target, w.pack, p.briefing);
	if (!briefed.ok) return toolResult(briefed.message, undefined, true);
	const asked = asksBehavior(w.pack, target) ? await behaviorStep(w, change.state, target, ctx) : { ok: true as const, state: change.state, checked: false };
	if (!asked.ok) return toolResult(asked.message, undefined, true);
	const state = asked.checked ? asked.state : await withGateChecks(w, asked.state, target);
	const refusal = gateRefusal(state, w.pack, target);
	if (refusal) return toolResult(refusalText(state, refusal), undefined, true);
	const plan = planGate(state, w.pack, target);
	if ("refused" in plan) return toolResult(plan.refused, undefined, true);
	if (plan.mode === "self") return passSelf(w, state, target);
	const unrecommendable = recommendationRefusal(briefed.briefing, plan);
	if (unrecommendable) return toolResult(unrecommendable, undefined, true);
	return askHuman(w, state, target, plan, ctx, briefed.briefing);
}

export const BRIEFING_SCHEMA = {
	type: "object",
	description: "Advisory briefing shown to the human after livespec's facts: summary, points to watch, the recommended choice and why. It is never an answer. spec_gate requires it on human gates; other tools accept it optionally.",
	properties: {
		summary: { type: "string", description: "what the human is deciding and what changed, at most 600 characters" },
		watch: { type: "array", items: { type: "string" }, description: "up to 5 one-line things to check before answering" },
		recommended: { type: "string", description: "id of the offered choice you suggest; needs rationale" },
		rationale: { type: "string", description: "why you suggest it, at most 600 characters" },
	},
	required: ["summary"],
};

export function registerSpecGate(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: "spec_gate",
		label: "Request a livespec gate",
		description:
			"Request the gate of the current livespec phase, or a registered named gate. A self gate passes when its checks pass; a human gate asks the human through the configured approver chain. The outcome comes only from the human; this tool takes no answer.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. Only `target`: no outcome or choice parameter.
		parameters: {
			type: "object",
			properties: { target: { type: "string", description: "The current phase id, or a registered named gate" }, briefing: BRIEFING_SCHEMA },
			required: ["target"],
		} as never,
		execute: (_id, params, _signal, _update, ctx) => runSpecGate({ target: (params as SpecGateParams).target, briefing: (params as SpecGateParams).briefing }, ctx as ApproverCtx),
	});
}
