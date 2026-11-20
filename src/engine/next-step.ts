// Pure decision: what to do next for a change, from a valid pack and the
// change state. Each precedence rule is one function; the first that returns
// a decision wins. The sentences are fixed copy for a stable card and tests.

import type { Question, Unit } from "../core/change.ts";
import { ADAPTER_NAMES, type AdapterName, type RequestMode } from "../interaction/approver.ts";
import { atOrAfterUnits } from "./gates.ts";
import { type GateResult, validApproval } from "./locks.ts";
import type { Pack, Phase, PhaseOutput } from "./pack-types.ts";
import { DEFAULT_LANES } from "../config.ts";
import { buildLoopStep, implementerHolds } from "../subagents/build-loop.ts";
import { eligibleLanes } from "../subagents/lanes.ts";
import { phaseEntryStep } from "../subagents/phase-entries.ts";
import { effectiveMode } from "./request-mode.ts";
import type { ChangeState, CheckResult, NextStep, SectionName } from "./state-types.ts";

type Decision = { next: string; advance?: string; dispatch?: NextStep["dispatch"] };

type UnitPlan = { ready: Unit[]; waiting: { id: string; waitingOn: string[] }[] };

type PendingEntry = NextStep["pending"][number];

/** A pending or applying request as the rules see it; applying requests always block. */
type OpenRequest = PendingEntry & { applying: boolean };

/** Frozen and stale units in the lock scope (design D8); both empty outside it. */
type ChangedUnits = { frozen: string[]; stale: string[] };

/** What the rules see: the state, the active phase and the facts derived from them once. */
type RuleInput = {
	pack: Pack;
	state: ChangeState;
	phase: Phase;
	blockingQuestions: Question[];
	units: UnitPlan;
	requests: OpenRequest[];
	changed: ChangedUnits;
};

type Rule = (i: RuleInput) => Decision | undefined;

const OUTPUT_SECTIONS: Record<Exclude<PhaseOutput, "specs-diff">, SectionName> = {
	"issue#Capabilities": "Capabilities",
	"issue#Proposal": "Proposal",
	"issue#Design": "Design",
	"issue#Units": "Units",
};

const UNITS_SENTENCE = "Write Units with plan_units.";
const SPECS_DIFF_SENTENCE = "Edit specs/ for the declared capabilities.";
const SHIP_PHASE = "ship";
const STUCK_SUBJECT = "stuck:";
const FORGE_ADAPTER: AdapterName = "forge";
const ADAPTER_PLACE: Record<AdapterName, string> = { forge: "on the forge", "in-session": "in session" };

/** The first phase, in pack order, whose `requires` include `phase`; undefined for the last phase. */
export function successorOf(pack: Pack, phase: string): string | undefined {
	return pack.phases.find((p) => p.requires.includes(phase))?.id;
}

// --- derived facts -----------------------------------------------------------

function openBlockingQuestions(state: ChangeState): Question[] {
	return state.change.questions.filter((q) => q.kind === "blocking" && !q.checked);
}

/**
 * Pending units split by whether every `Depends` target is a done unit; started units come first among the
 * ready ones. Only `per: unit` phases plan units.
 */
function planUnits(phase: Phase | undefined, units: Unit[], started: Record<string, unknown>): UnitPlan {
	if (phase?.per !== "unit") return { ready: [], waiting: [] };
	const done = new Set(units.filter((u) => u.done).map((u) => u.id));
	const plan: UnitPlan = { ready: [], waiting: [] };
	for (const unit of units.filter((u) => !u.done)) {
		const waitingOn = unit.depends.filter((d) => !done.has(d));
		if (waitingOn.length === 0) plan.ready.push(unit);
		else plan.waiting.push({ id: unit.id, waitingOn });
	}
	plan.ready.sort((a, b) => Number(!(a.id in started)) - Number(!(b.id in started)));
	return plan;
}

/** Ids of the units in `state.change` order that satisfy `keep`. */
const unitsWhere = (state: ChangeState, keep: (id: string) => boolean): string[] => state.change.units.map((u) => u.id).filter(keep);

function blockedUnits(state: ChangeState): NextStep["blockedUnits"] {
	return unitsWhere(state, (id) => id in state.evidence.blocked).map((id) => ({ id, reason: state.evidence.blocked[id] as "attempts" | "progress" }));
}

const pendingVerifier = (state: ChangeState): string[] => unitsWhere(state, (id) => state.evidence.started[id]?.pending === true);

/** The cap of `<loop>` or `<loop>.<unit>` is `loops[<loop>]`. */
function countersWithCaps(pack: Pack, counters: Record<string, number>): NextStep["counters"] {
	return Object.keys(counters)
		.sort()
		.map((name) => {
			const cap = pack.loops[name.split(".")[0] as string];
			return cap === undefined ? { name, value: counters[name] as number } : { name, value: counters[name] as number, cap };
		});
}

/** The adapter recorded in an answer, or `forge` when the comment data names no known adapter. */
function knownAdapter(name: unknown): AdapterName {
	return ADAPTER_NAMES.find((a) => a === name) ?? FORGE_ADAPTER;
}

/** Pending requests (always forge: in-session answers never leave one), then applying ones, in comment order. */
function openRequests(state: ChangeState): OpenRequest[] {
	const pending = state.requests.pending.map((r) => ({
		id: r.id,
		subject: r.subject,
		mode: effectiveMode(state, r.subject, r.mode),
		adapter: FORGE_ADAPTER,
		applying: false,
	}));
	const applying = state.requests.applying.map((r) => ({
		id: r.id,
		subject: r.subject,
		mode: effectiveMode(state, r.subject, r.record.request.mode),
		adapter: knownAdapter(r.record.answer.adapter),
		applying: true,
	}));
	return [...pending, ...applying];
}

/** Lock-derived blocks apply only while a lock exists and the phase is at or after the Units phase. */
function changedUnits(pack: Pack, state: ChangeState, phase: Phase | undefined): ChangedUnits {
	if (!phase || state.lock.locked === undefined || !atOrAfterUnits(pack, phase)) return { frozen: [], stale: [] };
	return { frozen: [...state.lock.frozen], stale: [...state.lock.staleUnits] };
}

/** The reason of the latest own `stale` comment naming `unit`, or its id when it has none. */
function staleReason(state: ChangeState, unit: string): string | undefined {
	const comment = state.marked.filter((m) => m.kind === "stale" && namesUnit(m.data, unit)).at(-1);
	if (!comment) return undefined;
	const reason = (comment.data as { reason?: unknown }).reason;
	return typeof reason === "string" && reason !== "" ? reason : comment.id;
}

function namesUnit(data: unknown, unit: string): boolean {
	const units = typeof data === "object" && data !== null ? (data as { units?: unknown }).units : undefined;
	return Array.isArray(units) && units.includes(unit);
}

function sentence(text: string): string {
	return text.replace(/[.\s]+$/, "");
}

// --- precedence rules (design.md, "Change state and next step") --------------

/** Rule 2: a change not started (no `Branch`) in a phase after the first one. */
const notStarted: Rule = ({ state, phase }) => {
	if (state.change.header.branch !== undefined || phase.requires.length === 0) return undefined;
	return { next: `Run change_start #${state.issue.number} to create the change branch.` };
};

/**
 * Rule 3: an unanswered stuck report. Without a pending or applying request for it (the send failed or
 * the request was lost), nobody is asked: the agent must send it again.
 */
const openStuck: Rule = ({ state, requests }) => {
	const id = state.iterations.stuckOpen;
	if (!id) return undefined;
	if (!requests.some((r) => r.subject === `${STUCK_SUBJECT}${id}`)) return { next: `Stuck report ${id} has no pending request: send it again with spec_stuck.` };
	return { next: `Wait for the human's choice on stuck report ${id}.` };
};

/** Rule 4: a pending blocking request, or any answered request whose effects are not yet applied. */
const openRequest: Rule = ({ requests }) => {
	const request = requests.find((r) => r.applying || r.mode === "blocking");
	if (!request) return undefined;
	if (request.applying) return { next: `The answer to ${request.subject} is not fully applied: run any livespec tool to finish it.` };
	return { next: `Wait for the human's answer to ${request.subject} ${ADAPTER_PLACE[request.adapter]}.` };
};

/** Rule 5: the `change_iterations` cap blocks until a stuck report is answered. */
const capBlocking: Rule = ({ state }) => {
	const it = state.iterations;
	return it.blocking ? { next: `Send a stuck report with spec_stuck: change_iterations reached ${it.count} of ${it.cap}.` } : undefined;
};

/** Rule 6: an open blocking question. */
const blockingQuestion: Rule = ({ blockingQuestions }) => {
	const first = blockingQuestions[0];
	return first ? { next: `Answer blocking question ${first.id} before continuing.` } : undefined;
};

function missingOutputSentence(output: PhaseOutput, state: ChangeState): string | undefined {
	if (output === "specs-diff") return state.git.specsChanged === true ? undefined : SPECS_DIFF_SENTENCE;
	const section = OUTPUT_SECTIONS[output];
	if (state.sections[section]) return undefined;
	return section === "Units" ? UNITS_SENTENCE : `Write ${section} with spec_write.`;
}

/** Rule 7: frozen units first, then stale units, in the lock scope. */
const changedUnit: Rule = ({ state, changed }) => {
	const frozen = changed.frozen[0];
	if (frozen) return { next: `Amend ${frozen} with unit_amend: it changed after the plan was locked.` };
	const stale = changed.stale[0];
	if (!stale) return undefined;
	const reason = staleReason(state, stale);
	return { next: `Amend ${stale} with unit_amend: ${reason === undefined ? "it is stale" : `it is stale after ${reason}`}.` };
};

/** Rule 8: the first missing phase output, in the phase's `outputs` order. */
const missingOutput: Rule = ({ state, phase }) => {
	for (const output of phase.outputs) {
		const next = missingOutputSentence(output, state);
		if (next) return { next };
	}
	return undefined;
};

/** Checks the valid approved gate result of `phase` waived; a superseded or unapproved result waives nothing. */
function waivedChecks(state: ChangeState, phase: Phase): Set<string> {
	const result = state.lock.gates[phase.id];
	return new Set(validApproval(result) ? (result?.waivers ?? []) : []);
}

/**
 * Rule 9: the first check result with severity `error`, named by its check; warnings never block, and
 * neither do checks the phase's valid approved gate waived.
 */
const failingCheck: Rule = ({ state, phase }) => {
	const waived = waivedChecks(state, phase);
	const failure: CheckResult | undefined = state.checks.find((r) => r.severity === "error" && !waived.has(r.check));
	return failure ? { next: `Fix ${failure.check}: ${sentence(failure.message)}.` } : undefined;
};

/** Rule 10: in a `per: unit` phase, a unit blocked by attempts or progress needs a stuck report. */
const blockedUnit: Rule = ({ state, phase }) => {
	if (phase.per !== "unit") return undefined;
	const blocked = blockedUnits(state)[0];
	if (!blocked) return undefined;
	return { next: `${blocked.id} is BLOCKED (${blocked.reason}): send a stuck report with spec_stuck.` };
};

/** Rule 11a: a child waiting on an answer, whatever the phase. */
const childQuestion: Rule = ({ state }) => {
	const pending = state.subagents.pending;
	if (!pending) return undefined;
	return { next: `Child ${pending.agentId} asks: ${pending.question} Answer it with subagent_answer ${pending.agentId} "<answer>", or raise it with spec_question when only the user can decide.` };
};

/** Rule 11a': outside `per: unit`, a scout or whole-change reviewer the policy holds that has not run, before the gate is requested. */
const phaseEntry: Rule = ({ pack, state, phase }) => phaseEntryStep(pack, state, phase);

/**
 * Rule 11b, lanes: open a lane for each eligible ready unit when two or more units would run in lanes
 * together and the implementer entry holds for each, before any unit is started; then start every open
 * lane's unit in its lane. A receipted unit missing its tick is ticked first (rule 12), so no lane opens before it.
 */
const laneUnits: Rule = ({ pack, state, phase }) => {
	if (phase.per !== "unit") return undefined;
	const lanes = Object.keys(state.subagents.lanes);
	if (Object.keys(state.evidence.started).length === 0 && state.evidence.untickedReceipts.length === 0) {
		const eligible = eligibleLanes(state, state.subagents.laneLimit ?? DEFAULT_LANES).filter((id) => implementerHolds(pack, state, phase, id));
		if (eligible.length > 0 && lanes.length + eligible.length >= 2) return { next: `Run these units in parallel lanes: ${eligible.map((id) => `lane_open ${id}`).join(", ")}.` };
	}
	const unstarted = lanes.find((id) => !(id in state.evidence.started));
	return unstarted === undefined ? undefined : { next: `Start ${unstarted} in its lane with unit_start ${unstarted}.` };
};

/** Rule 11c: in a `per: unit` phase, a started unit runs the build loop, then is finished before anything else is built. */
const startedUnit: Rule = ({ pack, state, phase }) => {
	if (phase.per !== "unit") return undefined;
	// A unit in the change worktree (e.g. a merged lane) finishes before lane units: lanes merge one at a time.
	const all = unitsWhere(state, (id) => id in state.evidence.started);
	const started = all.find((id) => !(id in state.subagents.lanes)) ?? all[0];
	if (!started) return undefined;
	return buildLoopStep(pack, state, phase, started) ?? { next: `Finish ${started} with unit_finish once Verify passes.` };
};

/** Rule 12: in a `per: unit` phase, a receipted unit whose tick is missing. */
const receiptedUnit: Rule = ({ state, phase }) => {
	if (phase.per !== "unit") return undefined;
	const unticked = state.evidence.untickedReceipts[0];
	return unticked ? { next: `Run unit_finish ${unticked} again to tick it.` } : undefined;
};

/** Rule 13: in a `per: unit` phase, the next ready unit, or the waiting units; no decision once every unit is done. */
const nextUnit: Rule = ({ units }) => {
	const ready = units.ready[0];
	if (ready) return { next: `Build ${ready.id} — ${ready.title}.` };
	if (units.waiting.length === 0) return undefined;
	const waits = units.waiting.map((b) => `${b.id} waits on ${b.waitingOn.join(", ")}`).join("; ");
	return { next: `No unit is ready: ${waits}.` };
};

/** Appends the human's notes; `next` is wrapped as untrusted where it is shown, so they are not wrapped here. */
function withNotes(text: string, notes: string): string {
	return notes === "" ? text : `${text} Notes: ${notes}`;
}

/** The sentence of a `self` or `human` gate with no gate result yet. */
function gateReady(phase: Phase): string {
	return phase.gate === "self" ? `Checks pass; the ${phase.id} gate can pass.` : `Ready for the ${phase.id} gate.`;
}

/**
 * A `self` or `human` gate, from the valid gate result of the phase (design D2): a superseded latest
 * result never falls back to an older one, and only an approved valid result advances, never at `ship`.
 */
function gateResultDecision(phase: Phase, successor: string, result: GateResult | undefined): Decision {
	const id = phase.id;
	if (validApproval(result)) {
		if (id === SHIP_PHASE) return { next: "The ship gate is approved: the change is ready to ship." };
		return { next: `The ${id} gate is approved: move to ${successor}.`, advance: successor };
	}
	if (result === undefined) return { next: gateReady(phase) };
	if (result.superseded) return { next: `The ${id} gate approval no longer matches the change: request the gate again.` };
	if (result.outcome === "changes_requested") return { next: withNotes(`The ${id} gate requested changes: revise, then request the gate again.`, result.notes) };
	return { next: withNotes(`The ${id} gate was dismissed: ask the human how to proceed.`, result.notes) };
}

/**
 * Rule 11, the fallback. The last phase has no further phase whatever its gate; otherwise the gate
 * decides, and a `gate: none` phase advances to its successor.
 */
function gate({ pack, state, phase }: RuleInput): Decision {
	const successor = successorOf(pack, phase.id);
	if (successor === undefined) return { next: "The flow has no further phase." };
	if (phase.gate !== "none") return gateResultDecision(phase, successor, state.lock.gates[phase.id]);
	return { next: `Move to ${successor}.`, advance: successor };
}

const RULES: Rule[] = [
	notStarted,
	openStuck,
	openRequest,
	capBlocking,
	blockingQuestion,
	changedUnit,
	missingOutput,
	failingCheck,
	blockedUnit,
	childQuestion,
	phaseEntry,
	laneUnits,
	startedUnit,
	receiptedUnit,
	nextUnit,
];

/** Rule 1, when no active phase resolves: no phase label, several, or one naming a phase the pack does not have. */
function labelRepair(state: ChangeState): string {
	const p = state.phase;
	if (p.kind === "missing") return "Repair labels: the issue has no livespec:phase/* label.";
	if (p.kind === "ambiguous") {
		return `Repair labels: the issue has several phase labels (${p.ids.join(", ")}); rerun the phase move.`;
	}
	return `Repair labels: phase ${p.id} is not in the flow pack.`;
}

function activePhase(pack: Pack, state: ChangeState): Phase | undefined {
	const p = state.phase;
	return p.kind === "ok" ? pack.phases.find((ph) => ph.id === p.id) : undefined;
}

function decide(i: RuleInput): Decision {
	for (const rule of RULES) {
		const decision = rule(i);
		if (decision) return decision;
	}
	return gate(i);
}

/** Pure: equal inputs give deeply equal results. Only call it with a valid pack. */
export function nextStep(pack: Pack, state: ChangeState): NextStep {
	const phase = activePhase(pack, state);
	const blockingQuestions = openBlockingQuestions(state);
	const units = planUnits(phase, state.change.units, state.evidence.started);
	const requests = openRequests(state);
	const changed = changedUnits(pack, state, phase);
	const decision: Decision = phase
		? decide({ pack, state, phase, blockingQuestions, units, requests, changed })
		: { next: labelRepair(state) };
	const step: NextStep = {
		phase: phase?.id,
		required: [...(phase?.skills.required ?? [])],
		optional: [...(phase?.skills.optional ?? [])],
		redirects: [...(phase?.redirects ?? [])],
		checks: [...state.checks],
		blockingQuestions,
		counters: countersWithCaps(pack, state.counters),
		activeUnits: units.ready.map((u) => u.id),
		waitingUnits: units.waiting,
		startedUnits: unitsWhere(state, (id) => id in state.evidence.started),
		blockedUnits: blockedUnits(state),
		untickedReceipts: [...state.evidence.untickedReceipts],
		pendingVerifier: pendingVerifier(state),
		incomplete: [...state.incomplete],
		pending: requests.map(({ id, subject, mode, adapter }) => ({ id, subject, mode, adapter })),
		frozenUnits: changed.frozen,
		staleUnits: changed.stale,
		next: decision.next,
	};
	if (state.iterations.stuckOpen !== undefined) step.stuckOpen = state.iterations.stuckOpen;
	if (decision.advance !== undefined) step.advance = decision.advance;
	if (decision.dispatch !== undefined) step.dispatch = decision.dispatch;
	const { pending } = state.subagents;
	if (pending !== undefined) step.pendingChild = { agentId: pending.agentId, question: pending.question };
	return step;
}
