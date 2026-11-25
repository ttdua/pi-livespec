// The `drift-severity` decision point: a pure rule over code-built facts, and
// `classify`, which runs it through `decide()` for every kept item.

import { isMap } from "yaml";
import type { RuleFn, RuleSchema } from "../decide/registry.ts";
import { checkAllowedKeys } from "../decide/rules/schema-util.ts";
import { decide } from "../decide/seam.ts";
import type { DriftItem, DriftType } from "./items.ts";

export type Severity = "major" | "minor";
export type Route = "change" | "small-fix";
export type ClassifiedItem = DriftItem & { severity: Severity; route: Route; retriaged?: { by: string; from: Severity } };
export type SeverityFacts = { type: DriftType; capabilityHasMajor: boolean };
export type SeverityOutcome = { severity: Severity; route: Route };

export const DRIFT_SEVERITY_POINT = "drift-severity";

/** Used when the pack has no `decisions.drift-severity` entry. */
const DEFAULT_CONFIG = { mode: "rule" };
const MAJOR_TYPES: ReadonlySet<DriftType> = new Set(["scenario-untested", "dead-paths", "removed-reference"]);
const MAJOR: SeverityOutcome = { severity: "major", route: "change" };
const MINOR: SeverityOutcome = { severity: "minor", route: "small-fix" };

/** `capabilityHasMajor`: another kept item of a Major type names the same capability. */
export function severityFacts(item: DriftItem, kept: DriftItem[]): SeverityFacts {
	const capabilityHasMajor =
		item.capability !== undefined && kept.some((o) => o !== item && MAJOR_TYPES.has(o.type) && o.capability === item.capability);
	return { type: item.type, capabilityHasMajor };
}

/** Never asks: Major for the spec-side types and for `declared-none` beside other Major drift, Minor otherwise. */
export const driftSeverityRule: RuleFn = (facts) => {
	const { type, capabilityHasMajor } = facts as SeverityFacts;
	if (MAJOR_TYPES.has(type)) return { outcome: MAJOR, reason: `${type} is Major drift` };
	if (type === "declared-none" && capabilityHasMajor) {
		return { outcome: MAJOR, reason: "declared-none on a capability with other Major drift" };
	}
	return { outcome: MINOR, reason: `${type} is Minor drift` };
};

export const driftSeveritySchema: RuleSchema = {
	validate(node, report) {
		if (isMap(node)) checkAllowedKeys(node, ["mode"], "decisions.drift-severity", report);
	},
};

/** Classifies every kept item through `decide()`; facts are computed over `items`. */
export async function classify(items: DriftItem[], config: unknown = DEFAULT_CONFIG): Promise<ClassifiedItem[]> {
	const out: ClassifiedItem[] = [];
	for (const item of items) {
		const decided = await decide(DRIFT_SEVERITY_POINT, severityFacts(item, items), { config, subject: item.key });
		if (decided.status !== "decided") throw new Error(`drift-severity asked for ${item.key}; the rule never asks`);
		out.push({ ...item, ...(decided.outcome as SeverityOutcome) });
	}
	return out;
}
