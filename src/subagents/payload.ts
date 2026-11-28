// Gate payload text for subagent output: advisory findings not yet shown at a gate and the parent's rebuttals.

import { untrusted } from "../hooks/phase-card.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { aggregateOf, latestRun } from "../review/records.ts";
import { findingState } from "../review/status.ts";
import { type AggregateFinding, current, findingKey, gatesShownKeys, rebuttalItems, type FindingSummaryData, type RebuttalData, reviewedUnits, unresolvedBlocking, unshownSystemFindings } from "./records.ts";
import type { Finding } from "./roles.ts";

const HEADING = "Subagent findings:";

const isRebuttal = (d: unknown): d is RebuttalData => typeof (d as Partial<RebuttalData> | null)?.rebuts === "string";

const findingLine = (f: Finding): string => `- ${f.severity} ${f.kind} at ${untrusted(f.location)}: ${untrusted(f.evidence)} (fix: ${untrusted(f.fix)})`;

type Listed = { lines: string[]; keys: string[] };

/** Every valid, current advisory finding no completed gate has shown yet, whatever its phase or reviewer entry. */
function advisoryListed(marked: MarkedComment[]): Listed {
	const shown = gatesShownKeys(marked);
	const out: Listed = { lines: [], keys: [] };
	for (const m of current(marked)) {
		if (m.kind !== "finding-summary" || isRebuttal(m.data)) continue;
		const data = m.data as FindingSummaryData;
		if (data.advisory !== true) continue;
		data.findings.forEach((f, i) => {
			const key = findingKey(m.ref, i);
			if (shown.has(key)) return;
			out.lines.push(findingLine(f));
			out.keys.push(key);
		});
	}
	return out;
}

/** Rebuttals as `summary:index reason — evidence`; reason and evidence are the parent's text, shown as data. */
function rebuttalLines(marked: MarkedComment[]): string[] {
	return [...rebuttalItems(marked)].flatMap(([ref, items]) => [...items.values()].map((i) => `- ${ref}:${i.index} ${untrusted(i.reason)} — ${untrusted(i.evidence)}`));
}

/** Blocking `out-of-scope` findings and informational system findings no completed gate has recorded yet: this gate's payload carries them. */
function outOfScopeListed(marked: MarkedComment[]): Listed {
	const shown = gatesShownKeys(marked);
	const open = reviewedUnits(marked).flatMap((unit) => unresolvedBlocking(marked, unit, new Set(), shown)).filter((o) => o.finding.scope === "out-of-scope");
	const system = unshownSystemFindings(marked, shown);
	const followUps = aggregateFollowUps(marked, shown);
	return {
		lines: [...open.map((o) => findingLine(o.finding)), ...system.map((o) => findingLine(o.finding)), ...followUps.lines],
		keys: [...open.map((o) => findingKey(o.comment, o.index)), ...system.map((o) => o.key), ...followUps.keys],
	};
}

/** The latest routed round's non-disputed `out-of-scope` follow-ups no completed gate has shown yet. */
function aggregateFollowUps(marked: MarkedComment[], shown: Set<string>): Listed {
	const out: Listed = { lines: [], keys: [] };
	const run = latestRun(marked);
	const aggregate = run?.routed ? aggregateOf(marked, run.round) : undefined;
	if (aggregate === undefined) return out;
	(aggregate.data.findings as AggregateFinding[]).forEach((f, i) => {
		const key = findingKey(aggregate.commentId, i);
		if (f.route !== "out-of-scope" || shown.has(key) || findingState(marked, aggregate.commentId, i, []) === "disputed") return;
		out.lines.push(findingLine(f));
		out.keys.push(key);
	});
	return out;
}

export type FindingsSection = { lines: string[]; keys: string[] };

/** The "Subagent findings" section of a gate payload and the keys of the findings it lists; empty when there is nothing to show. */
export function subagentFindingsSection(marked: MarkedComment[]): FindingsSection {
	const advisory = advisoryListed(marked);
	const rebuttals = rebuttalLines(marked);
	const outOfScope = outOfScopeListed(marked);
	if (advisory.lines.length === 0 && rebuttals.length === 0 && outOfScope.lines.length === 0) return { lines: [], keys: [] };
	const lines = [
		HEADING,
		...advisory.lines,
		...(outOfScope.lines.length === 0 ? [] : ["Out-of-scope findings:", ...outOfScope.lines]),
		...(rebuttals.length === 0 ? [] : ["Rebuttals:", ...rebuttals]),
	];
	return { lines, keys: [...advisory.keys, ...outOfScope.keys] };
}
