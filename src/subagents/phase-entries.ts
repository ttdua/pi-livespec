// The phase-level entries (scout, spec/plan/change reviewer) the next step suggests before a gate is requested.
// Pure: it reads the change state only. Advisory entries never block the gate; the suggestion only precedes it.

import type { Pack, Phase } from "../engine/pack-types.ts";
import type { ChangeState, NextStep } from "../engine/state-types.ts";
import { entriesFor, holds, type PolicyFacts } from "./policy.ts";
import { changeReviewDoneAt, settledRunSince } from "./records.ts";
import type { SubagentEntry } from "./roles.ts";

export type PhaseEntryStep = { next: string; dispatch: NonNullable<NextStep["dispatch"]> };

const LEVELS = ["low", "medium", "high"] as const;
type Level = (typeof LEVELS)[number];

/** Change-level policy facts: the highest unit `Difficulty`, the change's `unfamiliar-code` fact, no unit tags. */
function changeFacts(state: ChangeState): PolicyFacts {
	const { contextPercent, turnsCompleted, unfamiliar } = state.subagents;
	const ranks = state.change.units.map((u) => LEVELS.indexOf(u.difficulty as Level)).filter((r) => r >= 0);
	return {
		units: state.change.units.length,
		...(ranks.length === 0 ? {} : { maxDifficulty: LEVELS[Math.max(...ranks)] as Level }),
		tags: [],
		unfamiliar: unfamiliar.change,
		turnsCompleted,
		...(contextPercent === undefined ? {} : { contextPercent }),
	};
}

/** Scouts and reviewers of a whole-change subject; unit-level and verifier entries belong to other steps. */
const isPhaseLevel = (e: SubagentEntry): boolean => e.role === "scout" || (e.role === "reviewer" && e.subject !== undefined && e.subject !== "unit");

const entryHolds = (e: SubagentEntry, facts: PolicyFacts): boolean => e.mode === "always" || (e.mode === "auto" && holds(e, facts));

/** The index after which this phase's records count: the latest own gate comment of a phase it requires. */
function phaseStart(state: ChangeState, phase: Phase): number {
	let start = -1;
	state.marked.forEach((m, i) => {
		const named = (m.data as { phase?: unknown } | null)?.phase;
		if (m.kind === "gate" && typeof named === "string" && phase.requires.includes(named)) start = i;
	});
	return start;
}

/** A scout ran when a settled scout record exists since the phase began; a reviewer when a completed review covers HEAD. */
function entryRan(state: ChangeState, phase: Phase, e: SubagentEntry): boolean {
	if (e.role === "scout") return settledRunSince(state.marked.slice(phaseStart(state, phase) + 1), "scout");
	return e.subject !== undefined && changeReviewDoneAt(state.marked, e.subject, state.git.head);
}

/** No gate result for the phase yet, and no gate request for it pending or being applied. */
function beforeGate(state: ChangeState, phase: Phase): boolean {
	if (phase.gate === "none" || state.lock.gates[phase.id] !== undefined) return false;
	const subject = `gate:${phase.id}`;
	return !state.requests.pending.some((r) => r.subject === subject) && !state.requests.applying.some((r) => r.subject === subject);
}

function stepFor(state: ChangeState, phase: Phase, e: SubagentEntry): PhaseEntryStep {
	const args = [e.role, e.subject].filter((p) => p !== undefined).join(" ");
	const inline = !state.subagents.executor.ok;
	const run = inline ? `run it inline with subagent_packet ${args}, then record it with subagent_record ${args}` : `run subagent_dispatch ${args}`;
	const note = e.advisory === true ? " It is advisory: the gate can be requested without it." : "";
	return { next: `Before the ${phase.id} gate, ${run}.${note}`, dispatch: { role: e.role, ...(e.subject === undefined ? {} : { subject: e.subject }), inline } };
}

/** The first phase-level entry that holds and has not run for the current state, before the phase's gate is requested. */
export function phaseEntryStep(pack: Pack, state: ChangeState, phase: Phase): PhaseEntryStep | undefined {
	if (phase.per === "unit" || !beforeGate(state, phase)) return undefined;
	const facts = changeFacts(state);
	const due = entriesFor(pack, phase.id).find((e) => isPhaseLevel(e) && entryHolds(e, facts) && !entryRan(state, phase, e));
	return due === undefined ? undefined : stepFor(state, phase, due);
}
