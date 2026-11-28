// Decision rule registry: one rule per decision point, plus the `decisions`
// pack sub-schema that dispatches on the point key.

import { type Node, type Pair, isMap, isScalar } from "yaml";
import { registerPackSchema } from "../engine/registry.ts";
import { registerSubagentsSchema } from "../subagents/policy.ts";
import { progressRule, progressSchema } from "../evidence/progress-rule.ts";
import { difficultyRule, difficultySchema } from "./rules/difficulty.ts";
import { findingScopeRule, findingScopeSchema } from "../review/route.ts";
import { durableDocsRuleFn, durableDocsSchema } from "../ship/durable-docs.ts";
import { laneRuleFn, laneSchema } from "../fix/lane.ts";
import { splitRuleFn, splitSchema } from "../initiatives/split-rule.ts";
import { tagsRule, tagsSchema } from "./rules/tags.ts";
import { GATE_ESCALATION_POINT, gateEscalationRule, gateEscalationSchema } from "./rules/gate-escalation.ts";
import { BEHAVIOR_POINT, behaviorChangeRule, behaviorChangeSchema } from "../docs/behavior-change.ts";
import { DRIFT_SEVERITY_POINT, driftSeverityRule, driftSeveritySchema } from "../audit/severity.ts";

export type RuleResult =
	| { outcome: unknown; reason: string; data?: { agentAdditions?: string[] } }
	| { ask: { summary: string; options: { id: string; label: string; description: string }[]; recommended: string; rationale: string } };

export type RuleSchema = {
	validate(node: Node | null, report: (n: Node, msg: string) => void): void;
	merge?(base: unknown, over: unknown): unknown;
	/** Errors of the effective (merged) config: keys an override may omit but the final pack must have. */
	complete?(value: unknown): string[];
};

export type RuleFn = (facts: unknown, config: unknown) => RuleResult;
export type Rule = { schema: RuleSchema; fn: RuleFn };

const rules = new Map<string, Rule>();

type Raw = Record<string, unknown>;

function isRaw(v: unknown): v is Raw {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function keyName(pair: Pair): string | undefined {
	return isScalar(pair.key) ? String(pair.key.value) : undefined;
}

/** Checks the shared `mode: rule` key of one point's config. */
function validateMode(map: Node, modePair: Pair | undefined, report: (n: Node, msg: string) => void): void {
	const value = modePair?.value;
	if (isScalar(value) && value.value === "rule") return;
	if (isScalar(value) && value.value === "jev") {
		report(value, "`jev` is reserved for a later version; use `mode: rule`");
		return;
	}
	report((value as Node | null | undefined) ?? map, "`mode` must be `rule`");
}

/** Validates the whole `decisions` map: known points, `mode: rule`, then the point's own schema. */
function validateDecisions(node: Node | null, report: (n: Node, msg: string) => void): void {
	if (!isMap(node)) {
		if (node) report(node, "`decisions` must be a map");
		return;
	}
	for (const pair of node.items) {
		const point = keyName(pair);
		const rule = point === undefined ? undefined : rules.get(point);
		if (!rule) {
			report(pair.key as Node, `no rule is registered for decision point \`${point ?? "?"}\``);
			continue;
		}
		const value = pair.value as Node | null;
		if (!isMap(value)) {
			report((value ?? pair.key) as Node, `\`decisions.${point}\` must be a map`);
			continue;
		}
		validateMode(value, value.items.find((p) => keyName(p) === "mode"), report);
		rule.schema.validate(value, report);
	}
}

export function registerRule(point: string, schema: RuleSchema, fn: RuleFn): void {
	rules.set(point, { schema, fn });
	registerPackSchema("decisions", { validate: validateDecisions });
}

export function ruleFor(point: string): Rule | undefined {
	return rules.get(point);
}

export function resetRulesForTests(): void {
	rules.clear();
}

/** Registers the built-in rules and the `subagents` pack schema the default pack needs. */
export function registerBuiltinRules(): void {
	registerRule("tags", tagsSchema, tagsRule);
	registerRule("difficulty", difficultySchema, difficultyRule);
	registerRule("progress", progressSchema, progressRule);
	registerRule("finding-scope", findingScopeSchema, findingScopeRule);
	registerRule("durable-docs", durableDocsSchema, durableDocsRuleFn);
	registerRule("lane", laneSchema, laneRuleFn);
	registerRule("split", splitSchema, splitRuleFn);
	registerRule(BEHAVIOR_POINT, behaviorChangeSchema, behaviorChangeRule);
	registerRule(DRIFT_SEVERITY_POINT, driftSeveritySchema, driftSeverityRule);
	registerRule(GATE_ESCALATION_POINT, gateEscalationSchema, gateEscalationRule);
	registerSubagentsSchema();
}

/** Merges two `decisions` values per point: the point's `merge`, else a one-level spread. */
export function mergeDecisions(base: unknown, over: unknown): Record<string, unknown> {
	const b = isRaw(base) ? base : {};
	const o = isRaw(over) ? over : {};
	const merged: Record<string, unknown> = { ...b };
	for (const [point, value] of Object.entries(o)) {
		if (!Object.hasOwn(b, point)) {
			merged[point] = value;
			continue;
		}
		const merge = rules.get(point)?.schema.merge;
		merged[point] = merge ? merge(b[point], value) : { ...(isRaw(b[point]) ? b[point] : {}), ...(isRaw(value) ? value : {}) };
	}
	return merged;
}
