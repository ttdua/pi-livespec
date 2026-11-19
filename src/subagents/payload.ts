// Gate payload text for subagent output: advisory findings of the phase's reviewers and the parent's rebuttals.

import { untrusted } from "../hooks/phase-card.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { entriesFor } from "./policy.ts";
import { current, gatesShownKeys, type FindingSummaryData, type RebuttalData, reviewedUnits, unresolvedBlocking } from "./records.ts";
import type { Finding } from "./roles.ts";

const HEADING = "Subagent findings:";

const isRebuttal = (d: unknown): d is RebuttalData => typeof (d as Partial<RebuttalData> | null)?.rebuts === "string";

const findingLine = (f: Finding): string => `- ${f.severity} ${f.kind} at ${untrusted(f.location)}: ${untrusted(f.evidence)} (fix: ${untrusted(f.fix)})`;

/** Advisory reviews of the phase's own advisory reviewer entries: valid, current summaries only. */
function advisoryLines(marked: MarkedComment[], pack: Pack, target: string): string[] {
	const subjects = new Set(entriesFor(pack, target).filter((e) => e.role === "reviewer" && e.advisory === true).map((e) => e.subject));
	const lines: string[] = [];
	for (const m of current(marked)) {
		if (m.kind !== "finding-summary" || isRebuttal(m.data)) continue;
		const data = m.data as FindingSummaryData;
		if (data.advisory !== true || !subjects.has(data.subject)) continue;
		lines.push(...data.findings.map(findingLine));
	}
	return lines;
}

/** Rebuttals as `summary:index reason — evidence`; reason and evidence are the parent's text, shown as data. */
function rebuttalLines(marked: MarkedComment[]): string[] {
	const found = current(marked).filter((m) => m.kind === "finding-summary" && isRebuttal(m.data));
	return found.flatMap((m) => (m.data as RebuttalData).items.map((i) => `- ${(m.data as RebuttalData).rebuts}:${i.index} ${untrusted(i.reason)} — ${untrusted(i.evidence)}`));
}

/** Blocking `out-of-scope` findings no gate has shown yet: this gate's payload carries them. */
function outOfScopeLines(marked: MarkedComment[]): string[] {
	const shown = gatesShownKeys(marked);
	const open = reviewedUnits(marked).flatMap((unit) => unresolvedBlocking(marked, unit, new Set(), shown));
	return open.filter((o) => o.finding.scope === "out-of-scope").map((o) => findingLine(o.finding));
}

/** The "Subagent findings" section of a gate payload, or an empty list when there is nothing to show. */
export function subagentFindingsSection(marked: MarkedComment[], pack: Pack, target: string): string[] {
	const advisory = advisoryLines(marked, pack, target);
	const rebuttals = rebuttalLines(marked);
	const outOfScope = outOfScopeLines(marked);
	if (advisory.length === 0 && rebuttals.length === 0 && outOfScope.length === 0) return [];
	return [
		HEADING,
		...advisory,
		...(outOfScope.length === 0 ? [] : ["Out-of-scope findings:", ...outOfScope]),
		...(rebuttals.length === 0 ? [] : ["Rebuttals:", ...rebuttals]),
	];
}
