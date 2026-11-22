// The `split` rule (change-initiatives "Split rule"): from counts built by code, whether a change should be
// proposed as an initiative. Pure; the registered rule never asks.

import { isMap } from "yaml";
import type { Change } from "../core/change.ts";
import type { RuleFn, RuleSchema } from "../decide/registry.ts";
import { checkAllowedKeys } from "../decide/rules/schema-util.ts";
import type { Pack } from "../engine/pack-types.ts";
import { changeSize, exceededLimits, type SizeLimits, sizeLimitsOf } from "./size-limits.ts";

export type SplitFacts = { capabilities: number; units: number; limits: SizeLimits };
export type SplitOutcome = "propose" | "single";

export function splitFacts(change: Change, limits: Pack["limits"]): SplitFacts {
	return { ...changeSize(change), limits: sizeLimitsOf(limits) };
}

/** The registered rule: `propose` when a count exceeds its limit, else `single`; it never asks. */
export const splitRuleFn: RuleFn = (facts) => {
	const f = facts as SplitFacts;
	const reasons = exceededLimits(f, f.limits).map((e) => e.message);
	const outcome: SplitOutcome = reasons.length > 0 ? "propose" : "single";
	return { outcome, reason: reasons.join("; ") || "within max_units and max_capabilities" };
};

export const splitSchema: RuleSchema = {
	validate(node, report) {
		if (isMap(node)) checkAllowedKeys(node, ["mode"], "decisions.split", report);
	},
};
