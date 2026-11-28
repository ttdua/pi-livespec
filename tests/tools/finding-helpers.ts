// Seeds `finding-summary` records for the finding and unit-finish tool tests.
import { commitEntries, readLedger } from "../../src/ledger/store.ts";
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
	return (await h.marked()).at(-1)?.ref as string;
}

/** Appends a finding-summary entry that is a migrated copy of the forge comment `from`; returns its ref. */
export async function seedMigratedSummary(h: UnitHarness, from: string, findings: Finding[]): Promise<string> {
	const read = await readLedger(h.session.exec, h.root, h.n);
	const data = { role: "reviewer", subject: "unit", unit: "U1", round: ++round, status: "DONE", advisory: false, head: h.git("rev-parse", "HEAD"), packet: "p", sources_used: [], required: [], completed: true, agentSource: "s", requested: { thinking: "low" }, effective: {}, findings };
	const entry = { ref: `finding-summary.U1.unit.migrated~0000000a`, kind: "finding-summary" as const, id: "finding-summary.U1.unit.migrated", seq: read.entries.length + 1, at: new Date().toISOString(), from, data };
	const commit = await commitEntries(h.session.exec, h.root, h.n, read.tip, [entry]);
	h.git("update-ref", `refs/livespec/${h.n}`, commit);
	await h.session.comments?.invalidate(h.n);
	await h.session.refresh();
	return entry.ref;
}
