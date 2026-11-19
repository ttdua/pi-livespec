// Seeds `finding-summary` records for the finding and unit-finish tool tests.
import type { FindingSummaryData } from "../../src/subagents/records.ts";
import type { Finding } from "../../src/subagents/roles.ts";
import type { UnitHarness } from "./unit-helpers.ts";

export const warning = (over: Partial<Finding> = {}): Finding => ({ severity: "WARNING", kind: "defect", location: "a.ts:1", evidence: "e", fix: "f", scope: "unit", ...over });

let round = 0;

/** Posts an own unit review summary for U1 and returns its comment id. */
export async function seedSummary(h: UnitHarness, over: Partial<FindingSummaryData> = {}): Promise<string> {
	const data: FindingSummaryData = {
		role: "reviewer", subject: "unit", unit: "U1", round: ++round, status: "DONE", advisory: false, head: h.git("rev-parse", "HEAD"), packet: "p",
		sources_used: [], required: [], completed: true, agentSource: "s", requested: { thinking: "low" }, effective: {}, findings: [], ...over,
	};
	await h.seed("finding-summary", `finding-summary.${data.unit ?? "change"}.unit.${data.round}`, data);
	return (await h.marked()).at(-1)?.commentId as string;
}
