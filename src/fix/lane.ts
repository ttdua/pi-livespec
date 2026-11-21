// The `lane` rule (small-fix-lane "Lane rule", design D2): from facts built by code, whether a fix stays in the small
// lane or is forced into a full change, one reason per forcing condition. Pure; the registered rule never asks.

import { type Node, isMap, isScalar } from "yaml";
import type { RuleFn, RuleSchema } from "../decide/registry.ts";
import { checkAllowedKeys, keyName } from "../decide/rules/schema-util.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { LaneFacts, SpecChange } from "./lane-facts.ts";

export type LaneConfig = { mode: "rule"; max_files: number; max_lines: number };
export type LaneOutcome = { lane: "small" | "forced"; reasons: string[]; behavior_change?: "declared-none"; capabilities?: string[] };

const LIMITS = ["max_files", "max_lines"] as const;
const list = (names: string[]): string => names.join(", ");

function filesReason(facts: LaneFacts, config: LaneConfig): string[] {
	const n = facts.files.length;
	return n > config.max_files ? [`${n} changed files exceed max_files ${config.max_files}`] : [];
}

function linesReason(facts: LaneFacts, config: LaneConfig): string[] {
	return facts.lines > config.max_lines ? [`${facts.lines} changed lines exceed max_lines ${config.max_lines}`] : [];
}

/** One reason per spec whose requirement or scenario names changed; text edits never count. */
function specChangeReason(change: SpecChange): string[] {
	const parts: string[] = [];
	if (change.added_requirements.length > 0) parts.push(`adds requirements ${list(change.added_requirements)}`);
	if (change.removed_requirements.length > 0) parts.push(`removes requirements ${list(change.removed_requirements)}`);
	for (const s of change.scenarios) {
		if (s.added.length > 0) parts.push(`adds scenarios ${list(s.added)} to requirement ${s.requirement}`);
		if (s.removed.length > 0) parts.push(`removes scenarios ${list(s.removed)} from requirement ${s.requirement}`);
	}
	return parts.length > 0 ? [`specs/${change.capability}/spec.md ${parts.join("; ")}`] : [];
}

function specReasons(facts: LaneFacts): string[] {
	return facts.spec_changes.flatMap(specChangeReason);
}

function capabilityReason(facts: LaneFacts): string[] {
	return facts.created_capabilities.length > 0 ? [`creates capabilities ${list(facts.created_capabilities)}`] : [];
}

function governanceReason(facts: LaneFacts): string[] {
	return facts.governance.length > 0 ? [`changes governance files ${list(facts.governance)}`] : [];
}

/** Capabilities whose code changed while their spec did not: the fix declares no behavior change for them. */
function declaredNone(facts: LaneFacts): string[] {
	return facts.capability_code.filter((c) => !c.spec_changed).map((c) => c.capability);
}

export function laneRule(facts: LaneFacts, config: LaneConfig): LaneOutcome {
	const reasons = [...filesReason(facts, config), ...linesReason(facts, config), ...specReasons(facts), ...capabilityReason(facts), ...governanceReason(facts)];
	const outcome: LaneOutcome = { lane: reasons.length > 0 ? "forced" : "small", reasons };
	const capabilities = declaredNone(facts);
	return capabilities.length > 0 ? { ...outcome, behavior_change: "declared-none", capabilities } : outcome;
}

/** The registered rule: the outcome is the map above, and it never asks. */
export const laneRuleFn: RuleFn = (facts, config) => {
	const outcome = laneRule(facts as LaneFacts, config as LaneConfig);
	return { outcome, reason: outcome.reasons.join("; ") || "within the small-fix limits" };
};

function isPositiveInteger(node: Node | null): boolean {
	return isScalar(node) && typeof node.value === "number" && Number.isInteger(node.value) && node.value > 0;
}

export const laneSchema: RuleSchema = {
	validate(node, report) {
		if (!isMap(node)) return;
		checkAllowedKeys(node, ["mode", ...LIMITS], "decisions.lane", report);
		for (const pair of node.items) {
			const key = keyName(pair);
			if (!LIMITS.some((l) => l === key)) continue;
			const value = pair.value as Node | null;
			if (!isPositiveInteger(value)) report(value ?? (pair.key as Node), `\`decisions.lane.${key}\` must be a positive integer`);
		}
	},
	// An `extends` override may set one limit; the merged (or standalone) pack must have both.
	complete(value) {
		const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
		return LIMITS.filter((l) => typeof raw[l] !== "number").map((l) => `\`decisions.lane.${l}\` is missing`);
	},
};

/** The effective `lane` config of a valid pack, or why there is none (a standalone pack may omit or under-fill it). */
export function laneConfigOf(pack: Pack): LaneConfig | { invalid: string } {
	const value = pack.decisions.lane;
	const missing = value === undefined ? ["`decisions.lane` is missing"] : (laneSchema.complete?.(value) ?? []);
	if (missing.length > 0) return { invalid: `the flow pack has no complete \`decisions.lane\` config: ${missing.join("; ")}` };
	return value as LaneConfig;
}
