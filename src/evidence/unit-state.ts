// Derived unit state from own marked comments, read once in comment order: started units, receipts,
// attempts (`progress` records in the current budget) and blocked units.

import type { Change, Unit } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import { liftsCap } from "../engine/iterations.ts";
import { parkedUnitsOf } from "../engine/parked.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { type ReceiptRecord, type RebuildRecord, type StartRecord, asReceiptRecord, asRebuildRecord, asStartRecord } from "./records.ts";

export type UnitEvidence = {
	started: Record<string, StartRecord>;
	receipts: Record<string, ReceiptRecord[]>;
	attempts: Record<string, number>;
	blocked: Record<string, "attempts" | "progress">;
	untickedReceipts: string[];
	/** Units a review routed back: the latest `rebuild` is newer than the latest receipt and start. */
	rebuilds?: Record<string, { round: number; finding: string }>;
};

type Attempt = { index: number; outcome: unknown };

/** What one pass over the comments collects per unit, plus the latest lifting stuck answer. */
type Trail = {
	starts: Map<string, StartRecord>;
	receipts: Map<string, ReceiptRecord[]>;
	rebuilds: Map<string, RebuildRecord>;
	attempts: Map<string, Attempt[]>;
	/** The index of the latest non-resume `parked` record listing each unit. */
	parks: Map<string, number>;
	lastLift: number;
};

const PROGRESS_PREFIX = "progress.";
const NONE = -1;

const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
};

/** Every `progress.<unit>` decision comment counts as an attempt, whatever its data. */
function asAttempt(m: MarkedComment, index: number): { unit: string; attempt: Attempt } | undefined {
	if (m.kind !== "decision" || !m.id.startsWith(PROGRESS_PREFIX)) return undefined;
	const outcome = (m.data as { outcome?: unknown } | null)?.outcome;
	return { unit: m.id.slice(PROGRESS_PREFIX.length), attempt: { index, outcome } };
}

/** One pass over `marked` in comment order. */
function collect(marked: MarkedComment[]): Trail {
	const trail: Trail = { starts: new Map(), receipts: new Map(), rebuilds: new Map(), attempts: new Map(), parks: new Map(), lastLift: NONE };
	marked.forEach((m, index) => {
		const start = asStartRecord(m, index);
		if (start) trail.starts.set(start.unit, start);
		const receipt = asReceiptRecord(m, index);
		if (receipt) push(trail.receipts, receipt.unit, receipt);
		const rebuild = asRebuildRecord(m, index);
		if (rebuild) trail.rebuilds.set(rebuild.unit, rebuild);
		const progress = asAttempt(m, index);
		if (progress) push(trail.attempts, progress.unit, progress.attempt);
		for (const unit of parkedUnitsOf(m)) trail.parks.set(unit, index);
		if (liftsCap(m)) trail.lastLift = index;
	});
	return trail;
}

/** The comment index of the latest start, receipt, `parked` record listing `unit` or lifting stuck answer; NONE when there is none. */
function windowStart(trail: Trail, unit: string): number {
	return Math.max(trail.starts.get(unit)?.index ?? NONE, trail.receipts.get(unit)?.at(-1)?.index ?? NONE, trail.parks.get(unit) ?? NONE, trail.lastLift);
}

/** The comment index after which `progress` records of `unit` count towards its current attempt budget. */
export function budgetWindow(marked: MarkedComment[], unit: string): number {
	return windowStart(collect(marked), unit);
}

/** The attempts newer than the start, the latest receipt and the latest lifting stuck answer. */
function budgetAttempts(trail: Trail, unit: string): Attempt[] {
	const start = windowStart(trail, unit);
	return (trail.attempts.get(unit) ?? []).filter((a) => a.index > start);
}

function blockReason(budget: Attempt[], cap: number | undefined): "attempts" | "progress" | undefined {
	if (cap !== undefined && budget.length >= cap) return "attempts";
	if (budget.at(-1)?.outcome === "stop") return "progress";
	return undefined;
}

/** A pending unit whose latest receipt is newer than its latest start and matches its current digest. */
function hasUntickedReceipt(u: Unit, start: StartRecord | undefined, latest: ReceiptRecord | undefined, rebuild: RebuildRecord | undefined): boolean {
	if (rebuild !== undefined && rebuild.index > (latest?.index ?? NONE)) return false;
	return latest !== undefined && latest.index > (start?.index ?? NONE) && latest.digest === unitDigest(u);
}

export function deriveUnitEvidence(change: Change, marked: MarkedComment[], cap: number | undefined): UnitEvidence {
	const trail = collect(marked);
	const evidence: UnitEvidence = { started: {}, receipts: {}, attempts: {}, blocked: {}, untickedReceipts: [] };
	for (const u of change.units) {
		const start = trail.starts.get(u.id);
		const receipts = trail.receipts.get(u.id) ?? [];
		const latest = receipts.at(-1);
		if (receipts.length > 0) evidence.receipts[u.id] = receipts;
		if (trail.attempts.has(u.id)) evidence.attempts[u.id] = budgetAttempts(trail, u.id).length;
		if (u.done) continue;
		const rebuild = trail.rebuilds.get(u.id);
		// A rebuild or a park newer than the start makes that start stale: the unit restarts with unit_start.
		const superseded = Math.max(latest?.index ?? NONE, rebuild?.index ?? NONE, trail.parks.get(u.id) ?? NONE);
		if (start !== undefined && start.index > superseded) evidence.started[u.id] = start;
		if (rebuild !== undefined && rebuild.index > Math.max(latest?.index ?? NONE, start?.index ?? NONE)) {
			(evidence.rebuilds ??= {})[u.id] = { round: rebuild.round, finding: rebuild.finding };
		}
		if (hasUntickedReceipt(u, start, latest, rebuild)) evidence.untickedReceipts.push(u.id);
		const reason = blockReason(budgetAttempts(trail, u.id), cap);
		if (reason !== undefined) evidence.blocked[u.id] = reason;
	}
	return evidence;
}
