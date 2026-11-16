// Gate registration and the pure gate evaluation (design D7): named gates,
// per-phase review payload providers and gate refusal. Nothing here does I/O.

import { untrusted } from "../hooks/phase-card.ts";
import type { ReviewFacts } from "./gate-payload.ts";
import type { Pack, Phase } from "./pack-types.ts";
import { isWaivable } from "./registry.ts";
import type { ChangeState, CheckResult } from "./state-types.ts";

export type GateOption = { id: string; label: string };
export type NamedGate = { checks: string[]; options?: GateOption[] };
export type GatePayloadFn = (s: ChangeState, facts: ReviewFacts) => string | undefined;

/** What `spec_gate <target>` resolves to: the active phase's gate, or a registered named gate. */
export type GateTarget = { kind: "phase"; phase: Phase } | { kind: "named"; name: string; gate: NamedGate };

const UNITS_OUTPUT = "issue#Units";

const namedGates = new Map<string, NamedGate>();
const payloads = new Map<string, GatePayloadFn[]>();

export function registerGate(name: string, g: NamedGate): void {
	namedGates.set(name, g);
}

/** Adds a payload provider for `phase`; providers run in registration order. */
export function registerGatePayload(phase: string, fn: GatePayloadFn): void {
	payloads.set(phase, [...(payloads.get(phase) ?? []), fn]);
}

/** The extra payload sections registered for `phase`, in registration order, without empty ones. */
export function registeredPayload(phase: string, s: ChangeState, facts: ReviewFacts): string[] {
	return (payloads.get(phase) ?? []).map((fn) => fn(s, facts)).filter((t): t is string => t !== undefined && t !== "");
}

export function resetGatesForTests(): void {
	namedGates.clear();
	payloads.clear();
}

function activePhase(state: ChangeState, pack: Pack): Phase | undefined {
	const p = state.phase;
	return p.kind === "ok" ? pack.phases.find((ph) => ph.id === p.id) : undefined;
}

/** The current phase when `target` names it, else a registered named gate, else undefined. */
export function resolveGateTarget(state: ChangeState, pack: Pack, target: string): GateTarget | undefined {
	const phase = activePhase(state, pack);
	if (phase?.id === target) return { kind: "phase", phase };
	const gate = namedGates.get(target);
	return gate ? { kind: "named", name: target, gate } : undefined;
}

function checksOf(target: GateTarget): string[] {
	return target.kind === "phase" ? target.phase.checks : target.gate.checks;
}

/** Error results of the target's checks, in result order. */
function failingChecks(state: ChangeState, target: GateTarget): CheckResult[] {
	const names = new Set(checksOf(target));
	return state.checks.filter((r) => r.severity === "error" && names.has(r.check));
}

/** Names of the target's failing checks that a human may waive at the gate, unique, in result order. */
export function failingWaivable(state: ChangeState, pack: Pack, target: string): string[] {
	const resolved = resolveGateTarget(state, pack, target);
	if (!resolved) return [];
	return [...new Set(failingChecks(state, resolved).map((r) => r.check).filter(isWaivable))];
}

/** Whether `phase` is at or after the phase whose outputs include `issue#Units`, following `requires`. */
export function atOrAfterUnits(pack: Pack, phase: Phase): boolean {
	const seen = new Set<string>();
	const walk = (p: Phase | undefined): boolean => {
		if (!p || seen.has(p.id)) return false;
		seen.add(p.id);
		if (p.outputs.includes(UNITS_OUTPUT)) return true;
		return p.requires.some((id) => walk(pack.phases.find((x) => x.id === id)));
	};
	return walk(phase);
}

function sentence(text: string): string {
	return text.replace(/[.\s]+$/, "");
}

// --- refusal rules, in design D7 order; the first that refuses wins -------------

type RefusalInput = { state: ChangeState; pack: Pack; target: GateTarget; subject: string; ignoreRequest?: string };
type RefusalRule = (i: RefusalInput) => string | undefined;
type StateRule = (i: { state: ChangeState }) => string | undefined;

const noGate: RefusalRule = ({ target }) =>
	target.kind === "phase" && target.phase.gate === "none" ? `The ${target.phase.id} phase has no gate.` : undefined;

const blockingQuestion: StateRule = ({ state }) => {
	const q = state.change.questions.find((x) => x.kind === "blocking" && !x.checked);
	return q ? `Blocking question ${q.id} is open: answer it before requesting the gate.` : undefined;
};

const openStuck: StateRule = ({ state }) => {
	const id = state.iterations.stuckOpen;
	return id ? `Stuck report ${id} is unanswered: wait for the human's choice.` : undefined;
};

const capReached: StateRule = ({ state }) => {
	const it = state.iterations;
	return it.blocking ? `change_iterations reached ${it.count} of ${it.cap}: send a stuck report with spec_stuck first.` : undefined;
};

const pendingRequest: RefusalRule = ({ state, subject, ignoreRequest }) => {
	const pending = state.requests.pending.find((r) => r.subject === subject && r.id !== ignoreRequest);
	return pending
		? `A request for ${subject} is pending (${pending.id}): wait for its answer or end it with /livespec dismiss.`
		: undefined;
};

const dirtyTree: RefusalRule = ({ state }) =>
	state.git.dirty ? "The working tree is dirty: commit before requesting a gate." : undefined;

/** Only the plan gate while a lock exists; scope per design D8. */
const changedUnits: RefusalRule = ({ state, pack, target }) => {
	if (target.kind !== "phase" || !target.phase.outputs.includes(UNITS_OUTPUT) || !atOrAfterUnits(pack, target.phase)) return undefined;
	const lock = state.lock;
	if (lock.locked === undefined) return undefined;
	const named = [...lock.frozen.map((u) => ({ u, why: "frozen" })), ...lock.staleUnits.map((u) => ({ u, why: "stale" }))];
	if (named.length === 0) return undefined;
	const list = named.map(({ u, why }) => `${u} (${why})`).join(", ");
	return `Amend the units changed since the plan was locked with unit_amend first: ${list}.`;
};

const failingCheck: RefusalRule = ({ state, target }) => {
	const failure = failingChecks(state, target).find((r) => !isWaivable(r.check));
	// The check message can quote forge text (unit titles, file names), so it is wrapped as untrusted.
	return failure ? `Check ${failure.check} fails: ${untrusted(sentence(failure.message))}.` : undefined;
};

type StateInput = { state: ChangeState };

/** The first of blocking question, open stuck report and reached cap that refuses, or undefined. */
export function blockingStateRefusal(state: ChangeState): string | undefined {
	const input: StateInput = { state };
	for (const rule of [blockingQuestion, openStuck, capReached]) {
		const refusal = rule(input);
		if (refusal) return refusal;
	}
	return undefined;
}

const REFUSALS: RefusalRule[] = [noGate, blockingQuestion, openStuck, capReached, pendingRequest, dirtyTree, changedUnits, failingCheck];

/**
 * Why `spec_gate <target>` must refuse, or undefined when it may proceed. Pure. `ignoreRequest` is the
 * id of the request being completed, so its own pending entry does not refuse its validation.
 */
export function gateRefusal(state: ChangeState, pack: Pack, target: string, ignoreRequest?: string): string | undefined {
	const resolved = resolveGateTarget(state, pack, target);
	if (!resolved) {
		const current = activePhase(state, pack)?.id ?? "none";
		return `${target} is neither the current phase (${current}) nor a registered gate.`;
	}
	const input: RefusalInput = { state, pack, target: resolved, subject: `gate:${target}`, ignoreRequest };
	for (const rule of REFUSALS) {
		const refusal = rule(input);
		if (refusal) return refusal;
	}
	return undefined;
}
