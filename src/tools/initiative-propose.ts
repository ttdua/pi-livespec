// `initiative_propose` (spec "Initiative propose tool", "Initiative amendment"): reads what the plan
// needs from the forge, plans the drafts, and sends the `initiative` gate request. It writes no issue:
// the gate's completion does, once a human approves. It takes no outcome or choice.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseInitiative } from "../core/initiative.ts";
import type { DepState } from "../engine/deps-facts.ts";
import { LABEL_LIVESPEC } from "../forge/labels.ts";
import type { Forge, Issue } from "../forge/types.ts";
import { INITIATIVE_GATE, INITIATIVE_TOOL, registerInitiativeGate } from "../initiatives/complete.ts";
import { initiativeSummary } from "../initiatives/drafts.ts";
import { type InitiativeInput, type PlanCtx, planInitiative, referencedNumbers } from "../initiatives/propose.ts";
import { readReferenced } from "../initiatives/propose-read.ts";
import { dependencyFact, initiativeNumber, mergedOn } from "../initiatives/readiness.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { ApproverCtx } from "./approver-for.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { sendNamedGate } from "./spec-gate.ts";

/** The dependency state of every livespec issue read, so an amendment can tell an abandoned change. */
async function statesOf(forge: Forge, referenced: Map<number, Issue | "missing">): Promise<Map<number, DepState>> {
	const merged = mergedOn(forge);
	const issues = [...referenced.values()].filter((i): i is Issue => i !== "missing" && i.labels.includes(LABEL_LIVESPEC));
	const facts = await Promise.all(issues.map((i) => dependencyFact(i, merged)));
	return new Map(facts.map((f) => [f.number, f.state]));
}

/** Reads the open changes, the issues the input names, and the amended initiative with its entries. */
async function planCtx(forge: Forge, input: InitiativeInput, state: ChangeState): Promise<PlanCtx> {
	const open = await forge.searchIssues({ labels: [LABEL_LIVESPEC], state: "open" });
	const t = initiativeNumber(state.change);
	const tracking = await readReferenced(forge, t === undefined ? [] : [t]);
	const trackingIssue = t === undefined ? undefined : tracking.get(t);
	const entries = trackingIssue === undefined || trackingIssue === "missing" ? [] : parseInitiative(trackingIssue.body).changes.map((c) => c.number);
	const referenced = new Map([...tracking, ...(await readReferenced(forge, [state.issue.number, ...entries, ...referencedNumbers(input)]))]);
	return { open, referenced, ...(t === undefined ? {} : { states: await statesOf(forge, referenced) }) };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** The params as the plan reads them; the schema is the trust boundary, this only normalizes. */
function inputOf(p: unknown): InitiativeInput {
	const o = (p ?? {}) as Record<string, unknown>;
	const entries = Array.isArray(o.entries) ? o.entries : [];
	return {
		name: String(o.name ?? ""),
		goal: String(o.goal ?? ""),
		capabilities: strings(o.capabilities),
		entries: entries.map((e) => {
			const x = (e ?? {}) as Record<string, unknown>;
			return { name: String(x.name ?? ""), proposal: String(x.proposal ?? ""), depends: strings(x.depends) };
		}),
		...(o.remove === undefined ? {} : { remove: strings(o.remove) }),
	};
}

export async function runInitiativePropose(params: unknown, ctx: ApproverCtx): Promise<ToolResult<undefined>> {
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, undefined, true);
	const change = requireChange(w.session);
	if (!change.ok) return toolResult(change.message, undefined, true);
	const input = inputOf(params);
	const planned = planInitiative(input, change.state, await planCtx(w.forge, input, change.state));
	if ("refused" in planned) return toolResult(`${INITIATIVE_TOOL} refused: ${planned.refused} Nothing was requested.`, undefined, true);
	const summary = initiativeSummary(planned.drafts);
	return sendNamedGate(w, change.state, { target: INITIATIVE_GATE, options: [], drafts: planned.drafts, summary, ctx, tool: INITIATIVE_TOOL });
}

const ENTRY_SCHEMA = {
	type: "object",
	properties: {
		name: { type: "string", description: "kebab-case change name; the current change's entry uses its title" },
		proposal: { type: "string", description: "short Proposal, no level-2 heading" },
		depends: { type: "array", items: { type: "string" }, description: "names of other entries or #<n> of existing changes" },
	},
	required: ["name", "proposal", "depends"],
};

export function registerInitiativePropose(pi: ExtensionAPI): void {
	registerInitiativeGate();
	registerLivespecTool(pi, {
		name: INITIATIVE_TOOL,
		label: "Propose a livespec initiative",
		description:
			"Propose splitting the current change (in shape) into an initiative of several changes with Depends between them, or amend the initiative the change already belongs to. It sends the initiative gate to the human; the issues are created only after approval. This tool takes no answer.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No outcome or choice parameter.
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "kebab-case initiative name" },
				goal: { type: "string", description: "the initiative's goal" },
				capabilities: { type: "array", items: { type: "string" }, description: "capabilities the initiative covers" },
				entries: { type: "array", items: ENTRY_SCHEMA, description: "one entry per change, exactly one of them the current change" },
				remove: { type: "array", items: { type: "string" }, description: "amendment only: #<n> removes an abandoned change's entry, #<change>:#<dep> removes an abandoned dependency" },
			},
			required: ["name", "goal", "capabilities", "entries"],
		} as never,
		execute: (_id, params, _signal, _update, ctx) => runInitiativePropose(params, ctx as ApproverCtx),
	});
}
