// Registers the durable-doc checks (product-impact, glossary-terms, behavior-change) and the define gate's glossary section.

import { registerGatePayload } from "../engine/gates.ts";
import { registerCheck } from "../engine/registry.ts";
import { behaviorChangeCheck } from "./behavior-check.ts";
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
}
