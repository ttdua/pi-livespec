// The next step a `self` or `human` gate result decides (design D2). Pure.

import { type GateResult, validApproval } from "./locks.ts";
import type { Phase } from "./pack-types.ts";
import type { Decision } from "./state-types.ts";
import { SHIP_PHASE } from "../ship/phase.ts";

/** Appends the human's notes; `next` is wrapped as untrusted where it is shown, so they are not wrapped here. */
function withNotes(text: string, notes: string): string {
	return notes === "" ? text : `${text} Notes: ${notes}`;
}

/** The `gate-escalation` outcome the next step forecasts for a covered `self` gate (phase-gates "Escalation in the next step"). */
export type GateForecast = { outcome: "self" | "human"; reason: string; waivable?: string[] };

/** The sentence of a `self` or `human` gate with no gate result yet; a forecast `human` names the escalation. */
function gateReady(phase: Phase, forecast: GateForecast | undefined): string {
	if (forecast?.outcome === "human") {
		const waive = forecast.waivable?.length ? ` The human can waive ${forecast.waivable.join(", ")}, or fix them first.` : "";
		return `The ${phase.id} gate will ask the human: ${forecast.reason}. Pass a briefing to spec_gate ${phase.id}.${waive}`;
	}
	// Gate-only checks have not run here, so a covered gate may still escalate on them.
	if (forecast?.outcome === "self") return `Checks pass; the ${phase.id} gate can pass unless a gate-only check fails.`;
	return phase.gate === "self" ? `Checks pass; the ${phase.id} gate can pass.` : `Ready for the ${phase.id} gate.`;
}

/**
 * A `self` or `human` gate, from the valid gate result of the phase (design D2): a superseded latest
 * result never falls back to an older one, and only an approved valid result advances, never at `ship`.
 * `atHead` is false for an approval of a head-bound gate HEAD moved past, which counts as superseded.
 */
export function gateResultDecision(phase: Phase, successor: string, result: GateResult | undefined, atHead: boolean, forecast?: GateForecast): Decision {
	const id = phase.id;
	if (atHead) {
		if (id === SHIP_PHASE) return { next: "The ship gate is approved: run change_ship." };
		return { next: `The ${id} gate is approved: move to ${successor}.`, advance: successor };
	}
	if (result === undefined) return { next: gateReady(phase, forecast) };
	if (result.superseded || validApproval(result)) {
		return { next: `The ${id} gate approval no longer matches the change: request the gate again.` };
	}
	if (result.outcome === "changes_requested") return { next: withNotes(`The ${id} gate requested changes: revise, then request the gate again.`, result.notes) };
	return { next: withNotes(`The ${id} gate was dismissed: ask the human how to proceed.`, result.notes) };
}
