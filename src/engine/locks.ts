// The unit lock, frozen and stale units, stale phases and the valid gate result
// per phase (design D8, D2), derived purely from the body and own marked comments.
// Comment order is time order: the forge lists comments oldest first.

import { createHash } from "node:crypto";
import { type Change, parseChange } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { Outcome } from "../interaction/approver.ts";

/**
 * The valid gate result of a phase: its latest own gate comment newer than the latest `stale` listing it.
 * A superseded latest result is kept as-is (so callers can say "request again") and never replaced by an
 * older result; use `validApproval` to ask whether it approves. `notes` is the human's text (forge text: wrap
 * it as untrusted where it is shown on its own).
 */
export type GateResult = { outcome: Outcome; superseded: boolean; at: string; waivers: string[]; notes: string };

export type LockState = {
	locked: Record<string, string> | undefined;
	frozen: string[];
	staleUnits: string[];
	stalePhases: string[];
	gates: Record<string, GateResult | undefined>;
};

type GateData = GateResult & { name: string; locked?: Record<string, string> };
type AmendData = { action: "edit" | "add" | "drop"; unit: string; digest?: string; approved: boolean };
type StaleData = { phases: string[]; units: string[] };

/** One own marked comment this module reads, at its position in comment order. */
type Fact =
	| { kind: "gate"; at: number; data: GateData }
	| { kind: "amendment"; at: number; data: AmendData }
	| { kind: "stale"; at: number; data: StaleData };

const PLAN_PHASE = "plan";
const QUESTIONS_SECTION = "## Questions";
const OUTCOMES = new Set<string>(["approved", "approved_with_notes", "changes_requested", "dismissed"]);
const ACTIONS = new Set<string>(["edit", "add", "drop"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
/**
 * True only for an approved (with or without notes), non-superseded result; undefined is no approval.
 * The one approval test: gate results, amendments and answers (with their verdict) all use it.
 */
export function validApproval(r: Pick<GateResult, "outcome" | "superseded"> | undefined): boolean {
	return r !== undefined && (r.outcome === "approved" || r.outcome === "approved_with_notes") && !r.superseded;
}

// --- parsing own marked comments into facts ----------------------------------

function stringRecord(v: unknown): Record<string, string> | undefined {
	if (!isObject(v) || !Object.values(v).every((s) => typeof s === "string")) return undefined;
	return v as Record<string, string>;
}

function gateData(d: unknown): GateData | undefined {
	if (!isObject(d) || typeof d.outcome !== "string" || !OUTCOMES.has(d.outcome)) return undefined;
	const name = typeof d.phase === "string" ? d.phase : typeof d.gate === "string" ? d.gate : undefined;
	if (name === undefined) return undefined;
	const waivers = isStringList(d.waivers) ? [...d.waivers] : [];
	const notes = typeof d.notes === "string" ? d.notes : "";
	const data: GateData = { name, outcome: d.outcome as Outcome, superseded: d.superseded === true, at: typeof d.at === "string" ? d.at : "", waivers, notes };
	const locked = stringRecord(d.locked);
	if (locked) data.locked = locked;
	return data;
}

function amendData(d: unknown): AmendData | undefined {
	if (!isObject(d) || typeof d.action !== "string" || !ACTIONS.has(d.action) || typeof d.unit !== "string") return undefined;
	const approved = typeof d.outcome === "string" && OUTCOMES.has(d.outcome) && validApproval({ outcome: d.outcome as Outcome, superseded: d.superseded === true });
	const data: AmendData = { action: d.action as AmendData["action"], unit: d.unit, approved };
	if (typeof d.new === "string") data.digest = d.new;
	return data;
}

function staleData(d: unknown): StaleData | undefined {
	if (!isObject(d) || !isStringList(d.phases) || !isStringList(d.units)) return undefined;
	return { phases: d.phases, units: d.units };
}

function readFacts(marked: MarkedComment[]): Fact[] {
	const facts: Fact[] = [];
	marked.forEach((m, at) => {
		if (m.kind === "gate") {
			const data = gateData(m.data);
			if (data) facts.push({ kind: "gate", at, data });
		} else if (m.kind === "amendment") {
			const data = amendData(m.data);
			if (data) facts.push({ kind: "amendment", at, data });
		} else if (m.kind === "stale") {
			const data = staleData(m.data);
			if (data) facts.push({ kind: "stale", at, data });
		}
	});
	return facts;
}

// --- derivations ---------------------------------------------------------------

function gatesOf(facts: Fact[]): Extract<Fact, { kind: "gate" }>[] {
	return facts.filter((f): f is Extract<Fact, { kind: "gate" }> => f.kind === "gate");
}
function amendmentsOf(facts: Fact[]): Extract<Fact, { kind: "amendment" }>[] {
	return facts.filter((f): f is Extract<Fact, { kind: "amendment" }> => f.kind === "amendment");
}
function stalesOf(facts: Fact[]): Extract<Fact, { kind: "stale" }>[] {
	return facts.filter((f): f is Extract<Fact, { kind: "stale" }> => f.kind === "stale");
}

/** The latest approved, non-superseded plan gate's `locked` map, then every later approved amendment in order. */
function lockOf(facts: Fact[]): Record<string, string> | undefined {
	const base = gatesOf(facts)
		.filter((g) => g.data.name === PLAN_PHASE && validApproval(g.data))
		.pop();
	if (!base) return undefined;
	const locked: Record<string, string> = { ...(base.data.locked ?? {}) };
	for (const a of amendmentsOf(facts)) {
		if (a.at < base.at || !a.data.approved) continue;
		if (a.data.action === "drop") delete locked[a.data.unit];
		else if (a.data.digest !== undefined) locked[a.data.unit] = a.data.digest;
	}
	return locked;
}

/** Units in the body with no locked digest or a different current digest; none without a lock. */
function frozenOf(change: Change, locked: Record<string, string> | undefined): string[] {
	if (!locked) return [];
	return change.units.filter((u) => locked[u.id] !== unitDigest(u)).map((u) => u.id);
}

/** Units named by a `stale` comment with no approved amendment for them after it, in first-named order. */
function staleUnitsOf(facts: Fact[]): string[] {
	const amendments = amendmentsOf(facts);
	const stale = new Set<string>();
	for (const s of stalesOf(facts)) {
		for (const unit of s.data.units) {
			if (!amendments.some((a) => a.at > s.at && a.data.approved && a.data.unit === unit)) stale.add(unit);
		}
	}
	return [...stale];
}

/** Phases listed by a `stale` comment with no approved, non-superseded gate for them after it. */
function stalePhasesOf(facts: Fact[]): string[] {
	const gates = gatesOf(facts);
	const stale = new Set<string>();
	for (const s of stalesOf(facts)) {
		for (const phase of s.data.phases) {
			const reopened = gates.some((g) => g.at > s.at && g.data.name === phase && validApproval(g.data));
			if (!reopened) stale.add(phase);
		}
	}
	return [...stale];
}

/**
 * Per phase (or named gate), the latest own gate comment newer than the latest `stale` comment listing it.
 * A superseded latest result is reported as such and never falls back to an older one.
 */
function validGatesOf(facts: Fact[]): Record<string, GateResult | undefined> {
	const results: Record<string, GateResult | undefined> = {};
	const stales = stalesOf(facts);
	for (const g of gatesOf(facts)) {
		if (stales.some((s) => s.at > g.at && s.data.phases.includes(g.data.name))) continue;
		const { outcome, superseded, at, waivers, notes } = g.data;
		results[g.data.name] = { outcome, superseded, at, waivers, notes };
	}
	return results;
}

export function deriveLocks(change: Change, marked: MarkedComment[]): LockState {
	const facts = readFacts(marked);
	const locked = lockOf(facts);
	return {
		locked,
		frozen: frozenOf(change, locked),
		staleUnits: staleUnitsOf(facts),
		stalePhases: stalePhasesOf(facts),
		gates: validGatesOf(facts),
	};
}

/** Line indices of the `## Questions` section, heading included, up to the next H2. */
function questionLines(texts: string[]): Set<number> {
	const skip = new Set<number>();
	const start = texts.indexOf(QUESTIONS_SECTION);
	if (start === -1) return skip;
	for (let i = start; i < texts.length && (i === start || !texts[i]?.startsWith("## ")); i++) skip.add(i);
	return skip;
}

/** sha256 hex of the body without `## Questions`, with unit status lines blanked and line endings normalized. */
export function gateDigest(body: string): string {
	const change = parseChange(body);
	const texts = change.lines.map((l) => l.text);
	const skip = questionLines(texts);
	const status = new Set(change.units.map((u) => u.statusLine).filter((i) => i >= 0));
	const kept = texts.flatMap((t, i) => (skip.has(i) ? [] : [status.has(i) ? "" : t]));
	return createHash("sha256").update(kept.join("\n")).digest("hex");
}
