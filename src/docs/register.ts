// Registers the durable-doc checks (product-impact, glossary-terms, behavior-change) and the define gate's glossary section.

import type { MarkedComment } from "../forge/markers.ts";
import { registerGatePayload } from "../engine/gates.ts";
import { registerCheck } from "../engine/registry.ts";
import { neutralise } from "../interaction/briefing.ts";
import { behaviorChangeCheck } from "./behavior-check.ts";
import { type BehaviorItem, effectiveConclusion } from "./behavior-change.ts";
import { addedGlossaryEntries, glossaryTermsCheck } from "./glossary-terms.ts";
import { productImpactResults } from "./product-impact.ts";

export function registerDocChecks(): void {
	registerCheck("product-impact", async ({ change }) => productImpactResults(change));
	registerCheck("glossary-terms", glossaryTermsCheck);
	registerCheck("behavior-change", behaviorChangeCheck);
	registerGatePayload("define", (state, facts) => {
		const warnings = state.checks.filter((c) => c.check === "glossary-terms").map((c) => `- ${c.message}`);
		const entries = addedGlossaryEntries(facts.specsDiff).map((e) => `- Proposed entry: ${e}`);
		const lines = [...warnings, ...entries];
		return lines.length === 0 ? undefined : ["Glossary:", ...lines].join("\n");
	});
	registerGatePayload("define", (state, facts) => {
		const items = facts.behaviorItems ?? [];
		if (items.length === 0) return undefined;
		return ["Behavior conclusions (please check):", ...items.map((item) => behaviorLine(state.marked, item))].join("\n");
	});
}

/** One item's line: `- <capability>: <outcome> (<source>) — <rationale>; files: <n>`, or `none` without a conclusion. */
function behaviorLine(marked: MarkedComment[], item: BehaviorItem): string {
	const files = `; files: ${item.files.length}`;
	const c = effectiveConclusion(marked, item);
	if (c === undefined) return `- ${item.capability}: none${files}`;
	return `- ${item.capability}: ${c.outcome} (${c.source}) — ${neutralise(c.reason)}${files}`;
}
