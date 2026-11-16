// `plan_units` (design D9): the only tool that writes `## Units` before the plan
// is locked. A thin tool over the steps in `plan-units-steps.ts`: refuse, then
// reconcile the base, classify, validate, merge, post records, write the body,
// and set `livespecBase` only once the issue records the new `Base`.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../core/messages.ts";
import type { UnitInput } from "../core/unit-blocks.ts";
import { integrationBranch } from "../engine/git.ts";
import { blockingRequests } from "../engine/request-mode.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { Issue } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { ApproverCtx } from "./approver-for.ts";
import { normalizeUnitInput } from "./classify-units.ts";
import { createDecisionAsker } from "./decide-ask.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import {
	classifyPlan,
	mergeIntegration,
	planOnForge,
	plannedBody,
	postDecisionRecords,
	reconcileBase,
	setLivespecBase,
	validatePlan,
	type WriteOutcome,
	writePlan,
} from "./plan-units-steps.ts";
import { registerLivespecTool } from "./register.ts";

export type PlanUnitsParams = { units: UnitInput[] };

const UNITS_OUTPUT = "issue#Units";
const RERUN = "Rerun plan_units to reconcile.";

const refuse = (message: string): ToolResult<undefined> => toolResult(message, undefined, true);

/** Every refusal that needs no git or forge write, in design D9 order. */
export function planRefusal(w: WriteContext, state: ChangeState): string | undefined {
	const phaseId = state.phase.kind === "ok" ? state.phase.id : undefined;
	const phase = w.pack.phases.find((p) => p.id === phaseId);
	if (!phase?.outputs.includes(UNITS_OUTPUT)) return `plan_units refused: it runs only in the phase that outputs ${UNITS_OUTPUT}, and the change is in ${phaseId ?? "no phase"}.`;
	if (state.lock.locked !== undefined) return "plan_units refused: the plan is locked by an approved plan gate. Change units with unit_amend.";
	if (state.git.dirty) return "plan_units refused: the working tree has uncommitted changes; commit or stash them, then rerun plan_units.";
	const blocking = blockingRequests(state).map((r) => r.subject);
	if (blocking.length > 0) return `plan_units refused: a blocking request is pending (${blocking.map(untrusted).join(", ")}); wait for its answer.`;
	return undefined;
}

/** Settles a body write that did not succeed; undefined means the issue records the plan after all. */
async function settleWrite(w: WriteContext, n: number, body: string, base: string, outcome: Exclude<WriteOutcome, { kind: "written" }>): Promise<string | undefined> {
	if (outcome.kind === "conflict") {
		const changed = outcome.changed.join(", ") || "unknown fields";
		return `Version conflict on #${n} (${changed}): the units and Base were not written, and Base and livespecBase keep their previous value. The merge commit stays on the branch. ${RERUN}`;
	}
	if (await planOnForge(w.forge, n, body, base)) return undefined;
	return `Writing the units to #${n} failed with an unknown outcome (${untrusted(messageOf(outcome.error))}). ${RERUN}`;
}

/** Steps 6 and its failure handling: the body write, settled; undefined means the issue records the plan. */
async function recordPlan(w: WriteContext, issue: Issue, body: string, base: string): Promise<string | undefined> {
	const outcome = await writePlan(w.forge, issue, body);
	const failed = outcome.kind === "written" ? undefined : await settleWrite(w, issue.number, body, base, outcome);
	await afterForgeWrite(w.session, issue.number);
	return failed;
}

async function runPlan(w: WriteContext, state: ChangeState, units: UnitInput[], ctx: ApproverCtx): Promise<ToolResult<undefined>> {
	const n = state.issue.number;
	const git = w.session.git;
	const classifiedOrRefusal = await classifyPlan(units, w.pack.decisions, createDecisionAsker(w, state, ctx));
	if (!classifiedOrRefusal.ok) return refuse(classifiedOrRefusal.message);
	const classified = classifiedOrRefusal.plan;
	const issue = await w.forge.getIssue(n);
	const valid = validatePlan(issue.body, classified.units);
	if (!valid.ok) return refuse(valid.message);
	const project = w.session.config.project;
	const integration = project ? await integrationBranch(project, git) : undefined;
	if (integration === undefined) return refuse("plan_units refused: the integration branch is unknown: origin/HEAD is not set. Set integrationBranch in .pi/livespec/config.yaml.");
	const merged = await mergeIntegration(git, integration);
	if (!merged.ok) return refuse(merged.message);
	const unrecorded = await postDecisionRecords(w.forge, n, classified.records);
	if (unrecorded) {
		await afterForgeWrite(w.session, n);
		return refuse(unrecorded);
	}
	const failed = await recordPlan(w, issue, plannedBody(valid.body, merged.base), merged.base);
	if (failed) return refuse(failed);
	await setLivespecBase(git, state.git.branch, merged.base);
	const list = classified.units.map((u) => `${u.id} (${u.difficulty}, [${u.tags.join(", ")}])`).join(", ");
	return toolResult(`Planned ${classified.units.length} units on #${n}: ${list}. Base is ${merged.base}.`, undefined);
}

export async function runPlanUnits(p: PlanUnitsParams, ctx: ApproverCtx): Promise<ToolResult<undefined>> {
	const w = await prepareWrite();
	if (!w.ok) return refuse(w.message);
	const change = requireChange(w.session);
	if (!change.ok) return refuse(change.message);
	const { state } = change;
	if (await reconcileBase(w.session.git, state.git.branch, state.change.header.base)) await w.session.refresh();
	const refusal = planRefusal(w, state);
	if (refusal) return refuse(refusal);
	if (!Array.isArray(p.units) || p.units.length === 0) return refuse("plan_units refused: give at least one unit.");
	return runPlan(w, state, p.units.map(normalizeUnitInput), ctx);
}

const UNIT_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
		covers: { type: "array", items: { type: "string" }, description: "<capability>/Requirement: <name> entries" },
		files: { type: "array", items: { type: "string" } },
		done_means: { type: "array", items: { type: "object", properties: { label: { type: "string" }, text: { type: "string" } }, required: ["label", "text"] } },
		scenarios: { type: "array", items: { type: "object", properties: { label: { type: "string" }, ref: { type: "string" } }, required: ["label", "ref"] } },
		depends: { type: "array", items: { type: "string" }, description: "Ids of units this one depends on" },
		verify: { type: "string", description: "Exactly one command" },
		kind: { type: "string", enum: ["refactor"] },
		extra_tags: { type: "array", items: { type: "string" }, description: "Kebab-case tags to add; they can only add to the rule's tags" },
	},
	required: ["title", "covers", "files", "done_means", "scenarios", "depends", "verify"],
};

export function registerPlanUnits(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: "plan_units",
		label: "Plan livespec units",
		description:
			"Write the change's units before the plan is locked: assigns ids U1…Un, computes Difficulty and Tags by rule, validates, merges the integration branch and records Units and Base in the issue. After the plan gate, use unit_amend.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No Difficulty or Tags parameter.
		parameters: { type: "object", properties: { units: { type: "array", items: UNIT_SCHEMA } }, required: ["units"] } as never,
		execute: (_id, params, _signal, _update, ctx) => runPlanUnits({ units: (params as PlanUnitsParams).units }, ctx as ApproverCtx),
	});
}
