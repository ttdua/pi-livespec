// Pure decision: what to do next for a change, from a valid pack and the
// change state. Each precedence rule is one function; the first that returns
// a decision wins. The sentences are fixed copy for a stable card and tests.

import type { Question, Unit } from "../core/change.ts";
import type { AdapterName } from "../interaction/approver.ts";
import { atOrAfterUnits } from "./gates.ts";
import { type GateResult, validApproval } from "./locks.ts";
import type { Pack, Phase, PhaseOutput } from "./pack-types.ts";
import type { ChangeState, CheckResult, NextStep, SectionName } from "./state-types.ts";

type Decision = { next: string; advance?: string };

type UnitPlan = { ready: Unit[]; blocked: { id: string; waitingOn: string[] }[] };

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

const UNITS_SENTENCE = "Write Units (the plan_units tool arrives with LS-05).";
const SPECS_DIFF_SENTENCE = "Edit specs/ for the declared capabilities.";
const SHIP_PHASE = "ship";
const QUESTION_SUBJECT = "question:";
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

/** Pending units split by whether every `Depends` target is a done unit. Only `per: unit` phases plan units. */
function planUnits(phase: Phase | undefined, units: Unit[]): UnitPlan {
	if (phase?.per !== "unit") return { ready: [], blocked: [] };
	const done = new Set(units.filter((u) => u.done).map((u) => u.id));
	const plan: UnitPlan = { ready: [], blocked: [] };
	for (const unit of units.filter((u) => !u.done)) {
		const waitingOn = unit.depends.filter((d) => !done.has(d));
		if (waitingOn.length === 0) plan.ready.push(unit);
		else plan.blocked.push({ id: unit.id, waitingOn });
	}
	return plan;
}

/** The cap of `<loop>` or `<loop>.<unit>` is `loops[<loop>]`. */
function countersWithCaps(pack: Pack, counters: Record<string, number>): NextStep["counters"] {
	return Object.keys(counters)
		.sort()
		.map((name) => {
			const cap = pack.loops[name.split(".")[0] as string];
			return cap === undefined ? { name, value: counters[name] as number } : { name, value: counters[name] as number, cap };
		});
}

/**
 * A question request blocks only while its question is blocking in the body (design D4), so a
 * reclassification takes effect at once; other requests keep their stored mode.
 */
function effectiveMode(state: ChangeState, subject: string, stored: string): string {
	if (!subject.startsWith(QUESTION_SUBJECT)) return stored;
	const question = state.change.questions.find((q) => q.id === subject.slice(QUESTION_SUBJECT.length));
	if (!question) return stored;
	return question.kind === "blocking" ? "blocking" : "async";
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
		adapter: r.record.answer.adapter,
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

/** Rule 3: an unanswered stuck report. */
const openStuck: Rule = ({ state }) => {
	const id = state.iterations.stuckOpen;
	return id ? { next: `Wait for the human's choice on stuck report ${id}.` } : undefined;
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

/** Rule 9: the first check result with severity `error`, named by its check; warnings never block. */
const failingCheck: Rule = ({ state }) => {
	const failure: CheckResult | undefined = state.checks.find((r) => r.severity === "error");
	return failure ? { next: `Fix ${failure.check}: ${sentence(failure.message)}.` } : undefined;
};

/** Rule 10: in a `per: unit` phase, the next ready unit, or the blocked units; no decision once every unit is done. */
const nextUnit: Rule = ({ units }) => {
	const ready = units.ready[0];
	if (ready) return { next: `Build ${ready.id} — ${ready.title}.` };
	if (units.blocked.length === 0) return undefined;
	const waits = units.blocked.map((b) => `${b.id} waits on ${b.waitingOn.join(", ")}`).join("; ");
	return { next: `No unit is ready: ${waits}.` };
};

/**
 * A human gate, from the valid gate result of the phase (design D2): a superseded latest result
 * never falls back to an older one, and only an approved valid result advances, never at `ship`.
 */
function humanGate(phase: Phase, successor: string, result: GateResult | undefined): Decision {
	const id = phase.id;
	if (validApproval(result)) {
		if (id === SHIP_PHASE) return { next: "The ship gate is approved: the change is ready to ship." };
		return { next: `The ${id} gate is approved: move to ${successor}.`, advance: successor };
	}
	if (result === undefined) return { next: `Ready for the ${id} gate.` };
	if (result.superseded) return { next: `The ${id} gate approval no longer matches the change: request the gate again.` };
	if (result.outcome === "changes_requested") return { next: `The ${id} gate requested changes: revise, then request the gate again.` };
	return { next: `The ${id} gate was dismissed: ask the human how to proceed.` };
}

/**
 * Rule 11, the fallback. The last phase has no further phase whatever its gate; otherwise the gate
 * decides, and a `gate: none` phase advances to its successor.
 */
function gate({ pack, state, phase }: RuleInput): Decision {
	const successor = successorOf(pack, phase.id);
	if (successor === undefined) return { next: "The flow has no further phase." };
	if (phase.gate === "human") return humanGate(phase, successor, state.lock.gates[phase.id]);
	if (phase.gate === "self") return { next: `Checks pass; the ${phase.id} gate can pass.` };
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
	const units = planUnits(phase, state.change.units);
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
		blockedUnits: units.blocked,
		incomplete: [...state.incomplete],
		pending: requests.map(({ id, subject, mode, adapter }) => ({ id, subject, mode, adapter })),
		frozenUnits: changed.frozen,
		staleUnits: changed.stale,
		next: decision.next,
	};
	if (state.iterations.stuckOpen !== undefined) step.stuckOpen = state.iterations.stuckOpen;
	if (decision.advance !== undefined) step.advance = decision.advance;
	return step;
}
