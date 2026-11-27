// The pure planner of the spec-diff requirement cascade (design D2–D6): from the lock's requirement baseline,
// the own cascade records after it and the digests at HEAD and at the integration reference, it decides the
// one next step: a missing-baseline record, the completion of a partly applied cascade, or a new cascade.

import { createHash } from "node:crypto";
import type { Change } from "../core/change.ts";
import { type LockState, validApproval } from "../engine/locks.ts";
import type { Pack } from "../engine/pack-types.ts";
import { capabilityOf, changedIds, coversId, REMOVED_DIGEST } from "../engine/requirement-diff.ts";
import type { PhaseState } from "../engine/state-types.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { Outcome } from "./approver.ts";
import { phasesAfter } from "./complete-effects.ts";

/** The data of a cascade `stale` comment; `requirements` on a spec cascade, `baseline` on a missing-baseline record. */
export type StaleData = { reason: string; phases: string[]; units: string[]; after_plan: boolean; requirements?: Record<string, string>; baseline?: string };

/**
 * What the planner reads. `baseline` is the lock gate's record, else the digests at its `head_sha` (a lock from
 * before plan gates recorded them), else undefined (that commit is gone). `reference` is the digests at the
 * integration reference, undefined when it is unknown or was not needed.
 */
export type CascadeInput = {
	change: Change;
	marked: MarkedComment[];
	phase: PhaseState;
	pack: Pack;
	lock: LockState;
	baseline: Record<string, string> | undefined;
	scope: string[];
	heads: Record<string, string>;
	reference: Record<string, string> | undefined;
};

export type SpecCascadePlan =
	| { kind: "none" }
	| { kind: "cascade"; id: string; data: StaleData; untick: string[]; moveBack: boolean }
	| { kind: "complete"; untick: string[]; moveBack: boolean }
	| { kind: "legacy-missing"; id: string; data: StaleData; moveBack: boolean };

type SubPlanner = (input: CascadeInput) => SpecCascadePlan | undefined;

const DEFINE = "define";
const STALE_KIND = "stale";
const SPEC_PREFIX = "spec.";
const BASELINE_PREFIX = "baseline.";
const ID_HEX = 12;
const NONE: SpecCascadePlan = { kind: "none" };
/** Stands in for the lock commit of a gate that recorded no `head_sha`. */
const UNKNOWN_SHA = "unknown";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const isSpecCascade = (m: MarkedComment): boolean => m.kind === STALE_KIND && m.id.startsWith(SPEC_PREFIX);
export const isBaselineStale = (m: MarkedComment): boolean => m.kind === STALE_KIND && m.id.startsWith(BASELINE_PREFIX);

/** The `requirements` a spec-cascade comment acknowledged; {} when malformed. */
function recordedRequirements(m: MarkedComment): Record<string, string> {
	const r = isObject(m.data) ? m.data.requirements : undefined;
	if (!isObject(r)) return {};
	return Object.fromEntries(Object.entries(r).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function stringList(m: MarkedComment, key: "units" | "phases"): string[] {
	const v = isObject(m.data) ? m.data[key] : undefined;
	return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

/** Own comments matching `test` after the lock gate, in comment order; none without a lock. */
function afterBaseline(input: CascadeInput, test: (m: MarkedComment) => boolean): { m: MarkedComment; at: number }[] {
	const from = input.lock.baseline?.at;
	if (from === undefined) return [];
	return input.marked.flatMap((m, at) => (at > from && test(m) ? [{ m, at }] : []));
}

/**
 * Whether the change must move back to define: it is in a phase after define, or a previous try left it
 * half-moved (define plus a later phase).
 */
export function needsMoveBack(pack: Pack, phase: PhaseState): boolean {
	const later = phasesAfter(pack, DEFINE);
	if (phase.kind === "ok") return later.includes(phase.id);
	return phase.kind === "ambiguous" && phase.ids.includes(DEFINE) && phase.ids.some((id) => later.includes(id));
}

/** The baseline overlaid, in comment order, by every spec cascade after it; a recorded removal drops the id. */
export function acknowledgedDigests(input: CascadeInput): Record<string, string> {
	const acknowledged = { ...(input.baseline ?? {}) };
	for (const { m } of afterBaseline(input, isSpecCascade)) {
		for (const [id, digest] of Object.entries(recordedRequirements(m))) {
			if (digest === REMOVED_DIGEST) delete acknowledged[id];
			else acknowledged[id] = digest;
		}
	}
	return acknowledged;
}

/**
 * Changed ids the integration branch changed after the lock and HEAD took as-is: no own cascade named them,
 * their digest at HEAD equals the reference, and the reference differs from the baseline. An id absent at the
 * reference is never excluded, so a removal always cascades: a missed cascade would leave units ticked against
 * a removed requirement, a spurious one costs one define round.
 */
export function excludedIds(input: CascadeInput, changed: string[]): Set<string> {
	const { reference, heads, baseline = {} } = input;
	if (reference === undefined) return new Set();
	const named = new Set(afterBaseline(input, isSpecCascade).flatMap(({ m }) => Object.keys(recordedRequirements(m))));
	return new Set(changed.filter((id) => !named.has(id) && reference[id] !== undefined && reference[id] === heads[id] && reference[id] !== baseline[id]));
}

const cascadePhases = (pack: Pack): string[] => [DEFINE, ...phasesAfter(pack, DEFINE)];

/** Units whose trimmed `Covers` names one of `ids`, in body order. */
function coveringUnits(change: Change, ids: Set<string>): string[] {
	return change.units.filter((u) => u.covers.some((c) => ids.has(coversId(c)))).map((u) => u.id);
}

function doneOf(change: Change, units: string[]): string[] {
	const done = new Set(change.units.filter((u) => u.done).map((u) => u.id));
	return units.filter((u) => done.has(u));
}

/** Index of the latest valid define approval; -1 without one. */
function latestDefineApproval(marked: MarkedComment[]): number {
	const approves = (m: MarkedComment): boolean =>
		m.kind === "gate" && isObject(m.data) && m.data.phase === DEFINE && validApproval({ outcome: m.data.outcome as Outcome, superseded: m.data.superseded === true });
	return marked.map(approves).lastIndexOf(true);
}

// --- sub-planners ----------------------------------------------------------------

/** A lock whose baseline is unknown (no record, commit gone) gets one missing-baseline record. */
const planLegacyMissing: SubPlanner = (input) => {
	const lockGate = input.lock.baseline;
	if (input.baseline !== undefined || lockGate === undefined) return undefined;
	if (afterBaseline(input, isBaselineStale).length > 0) return undefined;
	const sha = lockGate.headSha ?? UNKNOWN_SHA;
	const data: StaleData = { reason: `the plan-lock commit ${sha} is missing; approve the spec and the plan again`, phases: cascadePhases(input.pack), units: [], after_plan: false, baseline: sha };
	return { kind: "legacy-missing", id: `${BASELINE_PREFIX}${sha.slice(0, ID_HEX)}`, data, moveBack: needsMoveBack(input.pack, input.phase) };
};

/** Finishes the untick and the move of cascade records already posted; writes no new comment. */
const planCompletion: SubPlanner = (input) => {
	const posted = afterBaseline(input, (m) => isSpecCascade(m) || isBaselineStale(m));
	const stale = new Set(input.lock.staleUnits);
	const named = [...new Set(posted.flatMap(({ m }) => stringList(m, "units")))].filter((u) => stale.has(u));
	const untick = doneOf(input.change, named);
	const approvedAt = latestDefineApproval(input.marked);
	const definePhase = input.pack.phases.find((p) => p.id === DEFINE);
	const moveBack =
		needsMoveBack(input.pack, input.phase) &&
		definePhase !== undefined &&
		definePhase.gate !== "none" &&
		posted.some(({ m, at }) => at > approvedAt && stringList(m, "phases").includes(DEFINE));
	return untick.length > 0 || moveBack ? { kind: "complete", untick, moveBack } : undefined;
};

/** The cascade id: unique per step after the baseline, identical on a rerun of the same step. */
function cascadeId(input: CascadeInput, requirements: Record<string, string>): string {
	const step = afterBaseline(input, isSpecCascade).length;
	const lines = Object.entries(requirements)
		.map(([id, digest]) => `${id}=${digest}`)
		.sort();
	return `${SPEC_PREFIX}${sha256([input.lock.baseline?.commentId ?? "", String(step), ...lines].join("\n")).slice(0, ID_HEX)}`;
}

/** HEAD digests of the capabilities in scope: a capability first covered after the lock is not compared. */
function headsInScope(input: CascadeInput): Record<string, string> {
	const scope = new Set(input.scope);
	return Object.fromEntries(Object.entries(input.heads).filter(([id]) => scope.has(capabilityOf(id) ?? "")));
}

/** A new cascade for every requirement whose HEAD digest differs from the acknowledged one, minus integration edits. */
const planNewCascade: SubPlanner = (input) => {
	if (input.baseline === undefined) return NONE;
	const heads = headsInScope(input);
	const diff = changedIds(acknowledgedDigests(input), heads);
	const excluded = excludedIds(input, diff);
	const changed = diff.filter((id) => !excluded.has(id));
	if (changed.length === 0) return NONE;
	const requirements = Object.fromEntries(changed.map((id) => [id, heads[id] ?? REMOVED_DIGEST]));
	const units = coveringUnits(input.change, new Set(changed));
	const moveBack = needsMoveBack(input.pack, input.phase);
	const data: StaleData = { reason: `requirements changed since the plan lock: ${changed.join(", ")}`, phases: cascadePhases(input.pack), units, after_plan: moveBack, requirements };
	return { kind: "cascade", id: cascadeId(input, requirements), data, untick: doneOf(input.change, units), moveBack };
};

const SUB_PLANNERS: SubPlanner[] = [planLegacyMissing, planCompletion, planNewCascade];

/** The next cascade step; the first sub-planner that returns a plan wins. Without a lock, none. */
export function planSpecCascade(input: CascadeInput): SpecCascadePlan {
	if (input.lock.baseline === undefined) return NONE;
	for (const plan of SUB_PLANNERS) {
		const planned = plan(input);
		if (planned !== undefined) return planned;
	}
	return NONE;
}
