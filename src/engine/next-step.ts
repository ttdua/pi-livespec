// Pure decision: what to do next for a change, from a valid pack and the
// change state. Each precedence rule is one function; the first that returns
// a decision wins. The sentences are fixed copy for a stable card and tests.

import type { Question, Unit } from "../core/change.ts";
import type { Pack, Phase, PhaseOutput } from "./pack-types.ts";
import type { ChangeState, CheckResult, NextStep, SectionName } from "./state-types.ts";

type Decision = { next: string; advance?: string };

type UnitPlan = { ready: Unit[]; blocked: { id: string; waitingOn: string[] }[] };

/** What the rules see: the state, the active phase and the facts derived from them once. */
type RuleInput = {
	pack: Pack;
	state: ChangeState;
	phase: Phase;
	blockingQuestions: Question[];
	units: UnitPlan;
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

function sentence(text: string): string {
	return text.replace(/[.\s]+$/, "");
}

// --- precedence rules (design.md, "Change state and next step") --------------

/** Rule 2: a change not started (no `Branch`) in a phase after the first one. */
const notStarted: Rule = ({ state, phase }) => {
	if (state.change.header.branch !== undefined || phase.requires.length === 0) return undefined;
	return { next: `Run change_start #${state.issue.number} to create the change branch.` };
};

/** Rule 3: an open blocking question. */
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

/** Rule 4: the first missing phase output, in the phase's `outputs` order. */
const missingOutput: Rule = ({ state, phase }) => {
	for (const output of phase.outputs) {
		const next = missingOutputSentence(output, state);
		if (next) return { next };
	}
	return undefined;
};

/** Rule 5: the first check result with severity `error`, named by its check; warnings never block. */
const failingCheck: Rule = ({ state }) => {
	const failure: CheckResult | undefined = state.checks.find((r) => r.severity === "error");
	return failure ? { next: `Fix ${failure.check}: ${sentence(failure.message)}.` } : undefined;
};

/** Rule 6: in a `per: unit` phase, the next ready unit, or the blocked units; no decision once every unit is done. */
const nextUnit: Rule = ({ units }) => {
	const ready = units.ready[0];
	if (ready) return { next: `Build ${ready.id} — ${ready.title}.` };
	if (units.blocked.length === 0) return undefined;
	const waits = units.blocked.map((b) => `${b.id} waits on ${b.waitingOn.join(", ")}`).join("; ");
	return { next: `No unit is ready: ${waits}.` };
};

/**
 * Rule 7, the fallback. The last phase has no further phase whatever its gate; otherwise the gate
 * decides, and a `gate: none` phase advances to its successor.
 */
function gate({ pack, phase }: RuleInput): Decision {
	const successor = successorOf(pack, phase.id);
	if (successor === undefined) return { next: "The flow has no further phase." };
	if (phase.gate === "human") return { next: `Ready for the ${phase.id} gate.` };
	if (phase.gate === "self") return { next: `Checks pass; the ${phase.id} gate can pass.` };
	return { next: `Move to ${successor}.`, advance: successor };
}

const RULES: Rule[] = [notStarted, blockingQuestion, missingOutput, failingCheck, nextUnit];

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
	const decision: Decision = phase
		? decide({ pack, state, phase, blockingQuestions, units })
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
		next: decision.next,
	};
	if (decision.advance !== undefined) step.advance = decision.advance;
	return step;
}
