// The build loop of a started unit, as next-step text: implementer, unit review, fix rounds, `spec_stuck`.
// Pure: it reads the change state only (records after the unit's start, HEAD, policy facts).

import type { Unit } from "../core/change.ts";
import type { Pack, Phase } from "../engine/pack-types.ts";
import type { ChangeState, NextStep } from "../engine/state-types.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { entriesFor, holds, type PolicyFacts } from "./policy.ts";
import { completedReviewAt, latestDispatch, unresolvedBlocking } from "./records.ts";
import type { ReviewSubject, Role, SubagentEntry } from "./roles.ts";

export type LoopStep = { next: string; dispatch?: NonNullable<NextStep["dispatch"]> };

const SMALL_FIX_PREFIX = "fix/";
const DEFAULT_REBUILDS = 2;
const SETTLED_OK = ["DONE", "DONE_WITH_CONCERNS"];
const LEVELS = ["low", "medium", "high"] as const;

/** Everything one step of the loop reads, derived once. */
type Loop = {
	unit: string;
	entries: SubagentEntry[];
	facts: PolicyFacts;
	since: MarkedComment[];
	head: string;
	preSha: string;
	inline: boolean;
	rebuilds: number;
};

const isLevel = (v: string | undefined): v is (typeof LEVELS)[number] => LEVELS.includes(v as never);

function policyFacts(state: ChangeState, unit: Unit): PolicyFacts {
	const { contextPercent, turnsCompleted } = state.subagents;
	return {
		units: state.change.units.length,
		...(isLevel(unit.difficulty) ? { difficulty: unit.difficulty } : {}),
		tags: unit.tags ?? [],
		unfamiliar: false,
		turnsCompleted,
		...(contextPercent === undefined ? {} : { contextPercent }),
	};
}

/** `off` never, `always` every time, `auto` when its conditions hold. */
function suggested(entry: SubagentEntry | undefined, facts: PolicyFacts): boolean {
	if (!entry || entry.mode === "off") return false;
	return entry.mode === "always" || holds(entry, facts);
}

const entryOf = (l: Loop, role: Role, subject?: ReviewSubject): SubagentEntry | undefined => l.entries.find((e) => e.role === role && e.subject === subject);

function loopOf(pack: Pack, state: ChangeState, phase: Phase, unitId: string): Loop | undefined {
	const unit = state.change.units.find((u) => u.id === unitId);
	const start = state.evidence.started[unitId];
	if (!unit || !start || state.git.branch.startsWith(SMALL_FIX_PREFIX)) return undefined;
	return {
		unit: unitId,
		entries: entriesFor(pack, phase.id),
		facts: policyFacts(state, unit),
		since: state.marked.slice(start.index + 1),
		head: state.git.head,
		preSha: start.pre.sha,
		inline: !state.subagents.executor.ok,
		rebuilds: pack.loops.unit_rebuilds ?? DEFAULT_REBUILDS,
	};
}

function argsOf(role: Role, unit: string, subject?: ReviewSubject): string {
	return [role, unit, subject].filter((p) => p !== undefined).join(" ");
}

/** The step naming a dispatch, or the inline pair `subagent_packet` / `subagent_record` when there is no executor. */
function dispatchStep(l: Loop, lead: string, role: Role, subject?: ReviewSubject): LoopStep {
	const args = argsOf(role, l.unit, subject);
	const dispatch = { role, unit: l.unit, ...(subject === undefined ? {} : { subject }), inline: l.inline };
	const next = l.inline
		? `${lead}: run it inline with subagent_packet ${args}, then record it with subagent_record ${args}.`
		: `${lead}: run subagent_dispatch ${args}.`;
	return { next, dispatch };
}

const implementerSuggested = (l: Loop): boolean => suggested(entryOf(l, "implementer"), l.facts);
const reviewSuggested = (l: Loop): boolean => suggested(entryOf(l, "reviewer", "unit"), l.facts);

function implementerDone(l: Loop): boolean {
	const record = latestDispatch(l.since, l.unit, "implementer");
	return record !== undefined && SETTLED_OK.includes(record.status);
}

/** Step 2: the implementer, when policy suggests one and no settled run exists since the unit started. */
function implementerStep(l: Loop): LoopStep | undefined {
	if (!implementerSuggested(l) || implementerDone(l)) return undefined;
	return dispatchStep(l, `Implement ${l.unit}`, "implementer");
}

/** Work to review: a settled implementer run, or (inline by policy) a HEAD that moved past the start. */
const workPresent = (l: Loop): boolean => (implementerSuggested(l) ? implementerDone(l) : l.head !== l.preSha);

/** Step 3: the unit review, when its entry holds and no completed review covers HEAD. */
function reviewStep(l: Loop): LoopStep | undefined {
	if (!reviewSuggested(l) || !workPresent(l) || completedReviewAt(l.since, l.unit, [l.head])) return undefined;
	return dispatchStep(l, `Review ${l.unit} before finishing`, "reviewer", "unit");
}

/** Completed non-advisory unit reviews since the start; each beyond the first follows one fix round. */
function reviewRounds(l: Loop): number {
	return l.since.filter((m) => {
		const d = m.kind === "finding-summary" ? (m.data as { role?: string; subject?: string; unit?: string; completed?: boolean; advisory?: boolean }) : undefined;
		return d?.role === "reviewer" && d.subject === "unit" && d.unit === l.unit && d.completed === true && d.advisory !== true;
	}).length;
}

/** Step 4: a fix round by the implementer with a new commit, or `spec_stuck` once `unit_rebuilds` rounds are used. */
function fixStep(l: Loop): LoopStep | undefined {
	const open = unresolvedBlocking(l.since, l.unit, new Set(), new Set());
	if (open.length === 0) return undefined;
	const used = Math.max(reviewRounds(l) - 1, 0);
	if (used >= l.rebuilds) {
		return { next: `Send a stuck report with spec_stuck, reason re-plan required: ${l.unit} still has ${open.length} blocking finding(s) after ${used} fix round(s).` };
	}
	const lead = `Fix round ${used + 1} for ${l.unit}: ${open.length} blocking finding(s); fix them in a new commit, never an amend`;
	if (!implementerSuggested(l)) return { next: `${lead}, then review again.` };
	return dispatchStep(l, lead, "implementer");
}

/** The next step of a started unit before `unit_finish`; undefined when the unit is ready to finish. */
export function buildLoopStep(pack: Pack, state: ChangeState, phase: Phase, unitId: string): LoopStep | undefined {
	const loop = loopOf(pack, state, phase, unitId);
	if (!loop) return undefined;
	return implementerStep(loop) ?? reviewStep(loop) ?? fixStep(loop);
}
