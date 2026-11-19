// The build loop of a started unit, as next-step text: implementer, unit review, fix rounds, `spec_stuck`.
// Pure: it reads the change state only (records after the unit's start, HEAD, policy facts).

import type { Unit } from "../core/change.ts";
import type { Pack, Phase } from "../engine/pack-types.ts";
import type { ChangeState, NextStep } from "../engine/state-types.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { entriesFor, holds, type PolicyFacts } from "./policy.ts";
import { answeredFindingKeys, completedUnitRounds, gatesShownKeys, latestDispatch, reviewStepDoneAt, unresolvedBlocking, type UnresolvedFinding } from "./records.ts";
import type { ReviewSubject, Role, SubagentEntry } from "./roles.ts";

export type LoopStep = { next: string; dispatch?: NonNullable<NextStep["dispatch"]> };

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
	questions: ChangeState["change"]["questions"];
};

const isLevel = (v: string | undefined): v is (typeof LEVELS)[number] => LEVELS.includes(v as never);

export function policyFacts(state: ChangeState, phase: Phase, unit: Unit): PolicyFacts {
	const { contextPercent, turnsCompleted, unfamiliar } = state.subagents;
	return {
		units: state.change.units.length,
		...(isLevel(unit.difficulty) ? { difficulty: unit.difficulty } : {}),
		tags: unit.tags ?? [],
		unfamiliar: phase.id === "build" ? unfamiliar.units[unit.id] === true : unfamiliar.change,
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
	if (!unit || !start) return undefined;
	return {
		unit: unitId,
		entries: entriesFor(pack, phase.id),
		facts: policyFacts(state, phase, unit),
		since: state.marked.slice(start.index + 1),
		head: state.git.head,
		preSha: start.pre.sha,
		inline: !state.subagents.executor.ok,
		rebuilds: pack.loops.unit_rebuilds ?? DEFAULT_REBUILDS,
		questions: state.change.questions,
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

/** Step 2: the implementer until a settled run exists since the unit started; inline when policy does not suggest a dispatch. */
function implementerStep(l: Loop): LoopStep | undefined {
	if (implementerDone(l)) return undefined;
	return dispatchStep(implementerSuggested(l) ? l : { ...l, inline: true }, `Implement ${l.unit}`, "implementer");
}

/** Step 3: the unit review, when its entry holds and no completed review of its kind covers HEAD. */
function reviewStep(l: Loop): LoopStep | undefined {
	const entry = entryOf(l, "reviewer", "unit");
	if (!reviewSuggested(l) || reviewStepDoneAt(l.since, l.unit, [l.head], entry?.advisory === true)) return undefined;
	return dispatchStep(l, `Review ${l.unit} before finishing`, "reviewer", "unit");
}

const FIXABLE = (f: UnresolvedFinding): boolean => f.finding.scope !== "needs-decision" && f.finding.scope !== "out-of-scope";

/** The open blocking findings, routed by the answered questions and the gates shown in the comments. */
function openFindings(l: Loop): UnresolvedFinding[] {
	return unresolvedBlocking(l.since, l.unit, answeredFindingKeys(l.questions), gatesShownKeys(l.since));
}

function questionStep(l: Loop, f: UnresolvedFinding): LoopStep {
	const ref = `finding:${f.comment}:${f.index}`;
	return { next: `${l.unit} has a blocking finding that needs a decision (${f.finding.location}): raise it with spec_question, starting the question text with ${ref}; no fix round is needed.` };
}

/** Step 4: a fix round by the implementer with a new commit, or `spec_stuck` once `unit_rebuilds` rounds are used. */
function fixRound(l: Loop, blocking: number): LoopStep {
	const used = Math.max(completedUnitRounds(l.since, l.unit) - 1, 0);
	if (used >= l.rebuilds) {
		return { next: `Send a stuck report with spec_stuck, reason re-plan required: ${l.unit} still has ${blocking} blocking finding(s) after ${used} fix round(s).` };
	}
	const lead = `Fix round ${used + 1} for ${l.unit}: ${blocking} blocking finding(s); fix them in a new commit, never an amend`;
	if (!implementerSuggested(l)) return { next: `${lead}, then review again.` };
	return dispatchStep(l, lead, "implementer");
}

/** Fix round for fixable findings, `spec_question` for a decision, a gate note for out-of-scope findings. */
function fixStep(l: Loop): LoopStep | undefined {
	const open = openFindings(l);
	const fixable = open.filter(FIXABLE);
	if (fixable.length > 0) return fixRound(l, fixable.length);
	const decision = open.find((f) => f.finding.scope === "needs-decision");
	if (decision) return questionStep(l, decision);
	if (open.length === 0) return undefined;
	return { next: `Finish ${l.unit} with unit_finish once Verify passes; ${open.length} out-of-scope finding(s) wait for the next human gate, no fix round.` };
}

/** The next step of a started unit before `unit_finish`; undefined when the unit is ready to finish. */
export function buildLoopStep(pack: Pack, state: ChangeState, phase: Phase, unitId: string): LoopStep | undefined {
	const loop = loopOf(pack, state, phase, unitId);
	if (!loop) return undefined;
	return implementerStep(loop) ?? reviewStep(loop) ?? fixStep(loop);
}
