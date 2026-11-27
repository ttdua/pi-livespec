// The `gate-escalation` rule (decision-seam "Gate escalation rule", design D4): from facts built by code,
// whether a listed `self` phase gate passes alone or asks the human, naming every trigger. Never asks.

import { type Node, isMap, isScalar, isSeq } from "yaml";
import type { GateEscalationFacts } from "../../engine/gate-escalation-facts.ts";
import type { Pack } from "../../engine/pack-types.ts";
import type { RuleFn, RuleSchema } from "../registry.ts";
import { checkAllowedKeys, keyName } from "./schema-util.ts";

export const GATE_ESCALATION_POINT = "gate-escalation";

export type GateEscalationConfig = { mode: "rule"; phases: string[]; tags: string[] };
export type GateEscalationOutcome = "self" | "human";

const LISTS = ["phases", "tags"] as const;
const NO_TRIGGER = "no trigger";

function advisoryReason(facts: GateEscalationFacts): string[] {
	if (facts.advisory_review === "missing") return [`advisory ${facts.phase} review missing at HEAD`];
	if (facts.advisory_review === "critical") return [`CRITICAL advisory finding in the ${facts.phase} review`];
	return [];
}

function tagReasons(facts: GateEscalationFacts, tags: string[]): string[] {
	return facts.units.flatMap((u) => {
		const hit = u.tags.filter((t) => tags.includes(t));
		return hit.length === 0 ? [] : [`${u.id} tagged ${hit.join(", ")}`];
	});
}

/** Every trigger that holds, in a fixed order: failing waivable checks, the advisory review, unit tags. */
export function escalationReasons(facts: GateEscalationFacts, config: GateEscalationConfig): string[] {
	const failing = facts.failing_waivable.map((c) => `${c} fails`);
	return [...failing, ...advisoryReason(facts), ...tagReasons(facts, config.tags)];
}

export const gateEscalationRule: RuleFn = (facts, config) => {
	const reasons = escalationReasons(facts as GateEscalationFacts, config as GateEscalationConfig);
	return reasons.length === 0 ? { outcome: "self", reason: NO_TRIGGER } : { outcome: "human", reason: reasons.join("; ") };
};

function validateList(key: string, node: Node | null, owner: Node, report: (n: Node, msg: string) => void): void {
	const path = `decisions.${GATE_ESCALATION_POINT}.${key}`;
	if (!isSeq(node)) {
		report(node ?? owner, `\`${path}\` must be a list of names`);
		return;
	}
	for (const item of node.items as Node[]) {
		if (!(isScalar(item) && typeof item.value === "string" && item.value !== "")) report(item, `\`${path}\` entries must be non-empty strings`);
	}
}

const isRaw = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const gateEscalationSchema: RuleSchema = {
	validate(node, report) {
		if (!isMap(node)) return;
		checkAllowedKeys(node, ["mode", ...LISTS], `decisions.${GATE_ESCALATION_POINT}`, report);
		for (const pair of node.items) {
			const key = keyName(pair);
			if (LISTS.some((l) => l === key)) validateList(key as string, pair.value as Node | null, pair.key as Node, report);
		}
	},
	// An override replaces each list it sets; the others keep the base value.
	merge(base, over) {
		return { ...(isRaw(base) ? base : {}), ...(isRaw(over) ? over : {}) };
	},
	complete(value) {
		const raw = isRaw(value) ? value : {};
		return LISTS.filter((l) => !Array.isArray(raw[l])).map((l) => `\`decisions.${GATE_ESCALATION_POINT}.${l}\` is missing`);
	},
};

/** The effective config when `phase` is a `self` gate the pack's `gate-escalation` config lists; else undefined. */
export function escalationConfigFor(pack: Pack, phase: string): GateEscalationConfig | undefined {
	const value = pack.decisions[GATE_ESCALATION_POINT];
	if (!isRaw(value) || !Array.isArray(value.phases) || !Array.isArray(value.tags)) return undefined;
	const config = value as GateEscalationConfig;
	if (!config.phases.includes(phase)) return undefined;
	return pack.phases.find((p) => p.id === phase)?.gate === "self" ? config : undefined;
}
