// Facts of the `gate-escalation` decision (decision-seam "Gate escalation facts"), built by code from the
// change state: never from the agent. Pure.

import { ruleFor } from "../decide/registry.ts";
import { escalationConfigFor, GATE_ESCALATION_POINT, type GateEscalationOutcome } from "../decide/rules/gate-escalation.ts";
import { entriesFor } from "../subagents/policy.ts";
import { latestChangeReviewAt } from "../subagents/records.ts";
import { failingWaivable } from "./gates.ts";
import type { Pack, Phase } from "./pack-types.ts";
import type { ChangeState } from "./state-types.ts";

export type AdvisoryReview = "none" | "missing" | "critical" | "clean";

export type GateEscalationFacts = {
	phase: string;
	head_sha: string;
	failing_waivable: string[];
	advisory_review: AdvisoryReview;
	units: { id: string; tags: string[] }[];
};

/** `none` without an `always` advisory reviewer of a whole-change subject; else what its latest review at HEAD reports. */
function advisoryReview(state: ChangeState, pack: Pack, phase: string): AdvisoryReview {
	const entry = entriesFor(pack, phase).find((e) => e.role === "reviewer" && e.advisory === true && e.mode === "always" && e.subject !== undefined && e.subject !== "unit");
	if (entry?.subject === undefined) return "none";
	const review = latestChangeReviewAt(state.marked, entry.subject, state.git.head);
	if (review === undefined) return "missing";
	return review.findings.some((f) => f.severity === "CRITICAL") ? "critical" : "clean";
}

/** The facts of `phase` at HEAD; `waivable` are the phase's failing waivable checks, as the caller ran them. */
export function gateEscalationFacts(state: ChangeState, pack: Pack, phase: string, waivable: string[]): GateEscalationFacts {
	return {
		phase,
		head_sha: state.git.head,
		failing_waivable: waivable,
		advisory_review: advisoryReview(state, pack, phase),
		units: state.change.units.map((u) => ({ id: u.id, tags: u.tags ?? [] })),
	};
}

export type Escalation = { outcome: GateEscalationOutcome; reason: string; facts: GateEscalationFacts };

/**
 * The facts of `phase` over the check results `state` holds, and the effective config; undefined when the phase
 * is not a `self` gate the `gate-escalation` config lists, so it never consults the rule.
 */
export function escalationInput(state: ChangeState, pack: Pack, phase: string): { facts: GateEscalationFacts; config: unknown } | undefined {
	if (escalationConfigFor(pack, phase) === undefined) return undefined;
	return { facts: gateEscalationFacts(state, pack, phase, failingWaivable(state, pack, phase)), config: pack.decisions[GATE_ESCALATION_POINT] };
}

/** A rule outcome of `gate-escalation`; anything but `self` or `human` is a programming error of the registered rule. */
export function escalationOutcome(outcome: unknown): GateEscalationOutcome {
	if (outcome === "self" || outcome === "human") return outcome;
	throw new Error(`decision \`${GATE_ESCALATION_POINT}\` returned \`${String(outcome)}\`; expected self or human`);
}

/** The next step's forecast of the gate (phase-gates "Escalation in the next step"), from the registered rule: writes nothing. */
export function escalationForecast(pack: Pack, state: ChangeState, phase: Phase): { outcome: GateEscalationOutcome; reason: string } | undefined {
	const input = escalationInput(state, pack, phase.id);
	const rule = ruleFor(GATE_ESCALATION_POINT);
	if (input === undefined || rule === undefined) return undefined;
	const result = rule.fn(input.facts, input.config);
	if (!("outcome" in result)) throw new Error(`the ${GATE_ESCALATION_POINT} rule never asks`);
	return { outcome: escalationOutcome(result.outcome), reason: result.reason };
}
