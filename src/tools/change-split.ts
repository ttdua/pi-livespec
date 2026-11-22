// `change_split #N --units U5,U6 --into <name>` (design D8, spec "Change split tool"): moves pending
// units of the current change into a new change issue. The planner refuses before anything is written;
// then the tool writes in spec order (new issue, #N body, stale comment and label, initiative), every
// body write versioned. A conflict stops the run and the message names what was already written.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { changeBody } from "../core/change-body.ts";
import { parseChange } from "../core/change.ts";
import { appendChange, initiativeBody, insertChangeAfter } from "../core/initiative.ts";
import { isKebabName } from "../core/names.ts";
import { setHeaderLine } from "../core/sections.ts";
import { insertUnitBlock } from "../core/unit-blocks.ts";
import { advancePhase } from "../engine/advance.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { Version } from "../forge/types.ts";
import { LABEL_INITIATIVE, LABEL_LIVESPEC, phaseLabel } from "../forge/labels.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { phasesAfter } from "../interaction/complete-effects.ts";
import { staleComment } from "../interaction/stale.ts";
import { dependencyNumbers, initiativeNumber } from "../initiatives/readiness.ts";
import { capabilitiesValue, pendingBlock, planSplit, type SplitPlan } from "../initiatives/split.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

export type ChangeSplitParams = { issue: number; units: string[]; into: string };
export type ChangeSplitDetails = { number?: number };

const TOOL = "change_split";
const FIRST_PHASE = "shape";
const PLAN_PHASE = "plan";
const SPLIT_SUFFIX = "-split";

/** `version` is the version of #N's body the plan was computed from. */
type Split = { w: WriteContext; state: ChangeState; plan: SplitPlan; into: string; version: Version; initiative?: number };

/** A conflict of a versioned write, with what the run already wrote. */
class SplitConflict extends Error {}

const refuse = (message: string): ToolResult<ChangeSplitDetails> => toolResult(`${TOOL} refused: ${message} Nothing was written.`, {}, true);

/** Refusals that need the forge: the name is taken by an open change, or the generated initiative name by an open initiative. */
async function nameRefusal(s: Pick<Split, "w" | "state" | "into" | "initiative">, dependsOnN: boolean): Promise<string | undefined> {
	const open = await s.w.forge.searchIssues({ labels: [LABEL_LIVESPEC], state: "open" });
	const taken = open.find((i) => i.title === s.into);
	if (taken) return `an open livespec change is already named ${untrusted(s.into)} (#${taken.number}).`;
	if (s.initiative !== undefined || !dependsOnN) return undefined;
	const name = `${s.state.issue.title}${SPLIT_SUFFIX}`;
	const tracking = (await s.w.forge.searchIssues({ labels: [LABEL_INITIATIVE], state: "open" })).find((i) => i.title === name);
	return tracking ? `an open initiative is already named ${untrusted(name)} (#${tracking.number}).` : undefined;
}

/** Step 1: the new change in `shape`, holding the moved blocks with pending status lines. */
async function createChange(s: Split): Promise<number> {
	const n = s.state.issue.number;
	const ids = s.plan.moved.map((u) => u.id).join(", ");
	const base = changeBody({ ...(s.initiative === undefined ? {} : { initiative: s.initiative }), depends: s.plan.dependsOnN ? [n] : [], proposal: `Split from #${n}: ${ids}.` });
	let body = setHeaderLine(base, "Capabilities", capabilitiesValue(s.plan.newCapabilities));
	for (const u of s.plan.moved) body = insertUnitBlock(body, pendingBlock(s.state.change, u));
	return (await s.w.forge.createIssue({ title: s.into, body, labels: [LABEL_LIVESPEC, phaseLabel(FIRST_PHASE)] })).number;
}

/** A versioned write of `edit(body)` on issue `n`; throws a SplitConflict when the body changed. */
async function writeBody(s: Split, n: number, edit: (body: string) => string): Promise<void> {
	const issue = await s.w.forge.getIssue(n);
	const written = await s.w.forge.updateIssueBody(n, edit(issue.body), issue.version);
	if (written.status === "conflict") throw new SplitConflict(`#${n} changed meanwhile (${written.changed.join(", ")})`);
}

/** Step 3: the stale comment for plan and every later phase, then the label back to plan when past it. */
async function reopenPlan(s: Split, m: number): Promise<void> {
	const n = s.state.issue.number;
	const later = phasesAfter(s.w.pack, PLAN_PHASE);
	const reason = `units ${s.plan.moved.map((u) => u.id).join(", ")} moved to #${m}`;
	await s.w.forge.createComment(n, staleComment(`stale.split.${m}`, { reason, phases: [PLAN_PHASE, ...later] }));
	if (s.state.phase.kind === "ok" && later.includes(s.state.phase.id)) await advancePhase(s.w.forge, n, PLAN_PHASE, s.w.pack);
}

/** Step 4: the new entry after #N's, or a `<title>-split` initiative listing both when the new change depends on #N. */
async function linkInitiative(s: Split, m: number, done: string[]): Promise<void> {
	const n = s.state.issue.number;
	const entry = { number: m, name: s.into, depends: s.plan.dependsOnN ? [n] : [] };
	if (s.initiative !== undefined) {
		await writeBody(s, s.initiative, (body) => insertChangeAfter(body, n, entry));
		done.push(`added #${m} to initiative #${s.initiative}`);
		return;
	}
	if (!s.plan.dependsOnN) return;
	const caps = [...new Set([...Object.values(s.plan.keptCapabilities).flat(), ...Object.values(s.plan.newCapabilities).flat()])];
	const own = { number: n, name: s.state.issue.title, depends: dependencyNumbers({ issue: s.state.issue, change: s.state.change }) };
	const body = appendChange(appendChange(initiativeBody(`Split of #${n} ${s.state.issue.title}`, caps), own), entry);
	const t = (await s.w.forge.createIssue({ title: `${s.state.issue.title}${SPLIT_SUFFIX}`, body, labels: [LABEL_INITIATIVE] })).number;
	done.push(`created initiative #${t}`);
	for (const k of [n, m]) {
		await writeBody(s, k, (b) => setHeaderLine(b, "Initiative", `#${t}`));
		done.push(`wrote Initiative #${t} on #${k}`);
	}
}

/** Steps 1 to 4 in order; returns the new issue and what was written, or the conflict that stopped the run. */
async function applySplit(s: Split): Promise<{ m?: number; done: string[]; conflict?: string }> {
	const done: string[] = [];
	let m: number | undefined;
	try {
		m = await createChange(s);
		done.push(`created #${m} ${s.into}`);
		const written = await s.w.forge.updateIssueBody(s.state.issue.number, s.plan.keptBody, s.version);
		if (written.status === "conflict") throw new SplitConflict(`#${s.state.issue.number} changed since the split was planned (${written.changed.join(", ")})`);
		done.push(`removed ${s.plan.moved.map((u) => u.id).join(", ")} from #${s.state.issue.number}`);
		await reopenPlan(s, m);
		done.push(`reopened the plan gate of #${s.state.issue.number}`);
		await linkInitiative(s, m, done);
		return { m, done };
	} catch (error) {
		if (error instanceof SplitConflict) return { ...(m === undefined ? {} : { m }), done, conflict: error.message };
		throw error;
	}
}

export async function runChangeSplit(p: ChangeSplitParams, ctx: ToolCtx): Promise<ToolResult<ChangeSplitDetails>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return { ...child, details: {} };
	if (!isKebabName(p.into)) return refuse(`the new change name must be kebab-case (a-z, 0-9, single hyphens): got ${untrusted(String(p.into))}.`);
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, {}, true);
	const change = requireChange(w.session);
	if (!change.ok) return toolResult(change.message, {}, true);
	const { state } = change;
	if (state.issue.number !== p.issue) return refuse(`run it on the branch of #${p.issue}; the current change is #${state.issue.number}.`);
	const read = await w.forge.getIssue(p.issue);
	const current = parseChange(read.body);
	const plan = planSplit(current, state, Array.isArray(p.units) ? p.units.map(String) : []);
	if ("refused" in plan) return refuse(plan.refused);
	const initiative = initiativeNumber(state.change);
	const s: Split = { w, state: { ...state, change: current }, plan, into: p.into, version: read.version, ...(initiative === undefined ? {} : { initiative }) };
	const taken = await nameRefusal(s, plan.dependsOnN);
	if (taken !== undefined) return refuse(taken);
	const out = await applySplit(s);
	await afterForgeWrite(w.session, p.issue);
	const details = out.m === undefined ? {} : { number: out.m };
	if (out.conflict !== undefined) return toolResult(`${TOOL} stopped: ${out.conflict}. Already written: ${out.done.join("; ") || "nothing"}. Finish the remaining steps by hand.`, details, true);
	return toolResult(withStep(w.session, `Split ${plan.moved.map((u) => u.id).join(", ")} of #${p.issue} into #${out.m} ${p.into} (shape): ${out.done.join("; ")}. The plan gate of #${p.issue} must be approved again.`), details);
}

export function registerChangeSplit(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Split a livespec change",
		description:
			"Move pending units of the current change #N into a new change issue in shape, with their capabilities, Depends: #N when a moved unit depends on one that stays, and the initiative entry. Reopens #N's plan gate. Refuses for done, started, in-lane or parked units, a remaining unit depending on a moved one, a taken name or a pending plan gate request.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No outcome or choice parameter.
		parameters: {
			type: "object",
			properties: {
				issue: { type: "number", description: "the current change's issue number #N" },
				units: { type: "array", items: { type: "string" }, description: "unit ids (U<n>) to move" },
				into: { type: "string", description: "kebab-case name of the new change" },
			},
			required: ["issue", "units", "into"],
		} as never,
		execute: (_id, params, _signal, _update, ctx) => runChangeSplit(params as ChangeSplitParams, ctx as ToolCtx),
	});
}
