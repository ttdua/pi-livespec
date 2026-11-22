// `new_dependency` (spec discovered-dependencies "New dependency tool"): reads what option A needs from the
// forge, plans the drafts, and sends the `new-dependency` gate request. It writes no issue: the gate's
// completion does, once a human approves. It takes no outcome or choice.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoveredDeps, NEW_DEPENDENCY_GATE } from "../engine/deps-facts.ts";
import { gateEffects, registerGate, registerGateEffect, registerGateValidator } from "../engine/gates.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { Forge } from "../forge/types.ts";
import { newDependencyEffect, validateNewDependency } from "../deps/effects.ts";
import { inputOf, NEW_DEPENDENCY_OPTIONS, NEW_DEPENDENCY_TOOL, newDependencySummary, offeredOptions, planNewDependency, referencedNumbers, type NewDependencyInput } from "../deps/new-dependency.ts";
import { type DependencyRead, readDependencyCtx } from "../deps/read.ts";
import { TooManyDependencies } from "../initiatives/propose-read.ts";
import type { ApproverCtx } from "./approver-for.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { sendNamedGate } from "./spec-gate.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

const refuse = (message: string): ToolResult<undefined> => toolResult(`${NEW_DEPENDENCY_TOOL} refused: ${message} Nothing was requested.`, undefined, true);

/** Registers the `new-dependency` gate with its validator and effect; called with the tool registration. */
export function registerNewDependencyGate(): void {
	registerGate(NEW_DEPENDENCY_GATE, { checks: [], options: NEW_DEPENDENCY_OPTIONS, proposer: NEW_DEPENDENCY_TOOL });
	registerGateValidator(NEW_DEPENDENCY_GATE, validateNewDependency);
	// Effects accumulate, and every tool registration calls this: add the effect once.
	if (!gateEffects(NEW_DEPENDENCY_GATE).includes(newDependencyEffect)) registerGateEffect(NEW_DEPENDENCY_GATE, newDependencyEffect);
}

/** The cap refusal: the count reached `loops.discovered_deps` and no stuck answer lifted it since. */
function capRefusal(state: ChangeState, cap: number | undefined): string | undefined {
	const deps = discoveredDeps(state.marked, cap);
	return deps.blocking ? `discovered_deps reached ${deps.value} of ${cap}: send a stuck report with spec_stuck, so the human can send the work back to the initiative's shape.` : undefined;
}

async function readCtx(forge: Forge, state: ChangeState, input: NewDependencyInput): Promise<DependencyRead | { refused: string }> {
	try {
		return await readDependencyCtx(forge, state.issue.number, state.change, referencedNumbers(input));
	} catch (error) {
		if (error instanceof TooManyDependencies) return { refused: `${error.message}.` };
		throw error;
	}
}

export async function runNewDependency(params: unknown, ctx: ToolCtx & ApproverCtx): Promise<ToolResult<undefined>> {
	const child = childRefusal(NEW_DEPENDENCY_TOOL, ctx);
	if (child) return child;
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, undefined, true);
	const change = requireChange(w.session);
	if (!change.ok) return toolResult(change.message, undefined, true);
	const { state } = change;
	const capped = capRefusal(state, w.pack.loops.discovered_deps);
	if (capped) return refuse(capped);
	const input = inputOf(params);
	const read = await readCtx(w.forge, state, input);
	if ("refused" in read) return refuse(read.refused);
	const planned = planNewDependency(input, state, read);
	if ("refused" in planned) return refuse(planned.refused);
	const options = offeredOptions(state);
	const summary = newDependencySummary(planned.drafts, state, options, read.initiative);
	return sendNamedGate(w, state, { target: NEW_DEPENDENCY_GATE, options, drafts: planned.drafts, summary, ctx, tool: NEW_DEPENDENCY_TOOL });
}

const NEW_CHANGE = (what: string) => ({
	type: "object",
	properties: {
		name: { type: "string", description: `kebab-case name of the ${what}` },
		proposal: { type: "string", description: "short Proposal, no level-2 heading" },
	},
	required: ["name", "proposal"],
});

export function registerNewDependency(pi: ExtensionAPI): void {
	registerNewDependencyGate();
	registerLivespecTool(pi, {
		name: NEW_DEPENDENCY_TOOL,
		label: "Propose how to handle a discovered dependency",
		description:
			"When a unit needs work outside the change (an implementer returned BLOCKED missing-prerequisite), draft each option and send the new-dependency gate to the human: A (default) a prerequisite change and park this one, B new units, C a stub plus a follow-up change, D back to shape or drop, and split at a finished-unit boundary. Nothing is created before approval. This tool takes no answer.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No outcome or choice parameter.
		parameters: {
			type: "object",
			properties: {
				unit: { type: "string", description: "the unit that found the dependency, e.g. U3" },
				evidence: { type: "string", description: "what is missing and why, from the child's evidence" },
				a: {
					...NEW_CHANGE("prerequisite change"),
					properties: { ...NEW_CHANGE("prerequisite change").properties, depends: { type: "array", items: { type: "string" }, description: "#<n> of existing changes the prerequisite depends on" } },
				},
				b: { type: "object", properties: { units: { type: "array", items: { type: "string" }, description: "ids of the units to add" }, summary: { type: "string" } }, required: ["units", "summary"] },
				c: { type: "object", properties: { summary: { type: "string", description: "the stub amendment" }, follow_up: NEW_CHANGE("follow-up change") }, required: ["summary", "follow_up"] },
				d: { type: "object", properties: { action: { type: "string", enum: ["shape", "drop"] }, reason: { type: "string" } }, required: ["action", "reason"] },
			},
			required: ["evidence", "a", "b", "c", "d"],
		} as never,
		execute: (_id, params, _signal, _update, ctx) => runNewDependency(params, ctx as ToolCtx & ApproverCtx),
	});
}
