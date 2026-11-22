// Dependency facts shared by the readiness reads and the change state, and the facts derived from
// own `new-dependency` gate results (design D10): the `discovered_deps` counter and the latest choice.
// Pure over own marked comments in comment (time) order.

import type { MarkedComment } from "../forge/markers.ts";
import type { Outcome } from "../interaction/approver.ts";
import { liftsCap } from "./iterations.ts";
import { validApproval } from "./locks.ts";

export type DepState = "merged" | "open" | "abandoned";
export type DepFact = { number: number; title: string; state: DepState };
export type ParkedUnit = { unit: string; branch?: string; head?: string; lane: boolean };

export const NEW_DEPENDENCY_GATE = "new-dependency";
export const DEPENDENCY_CHOICES = ["A", "B", "C", "D", "split"] as const;
export type DependencyChoice = (typeof DEPENDENCY_CHOICES)[number];

/**
 * The latest valid approved `new-dependency` choice. `index` is the gate comment's position in `marked`;
 * `action` and `reason` come from option D's draft, `unit` from the request's drafts.
 */
export type LatestDependencyChoice = { choice: DependencyChoice; action?: "shape" | "drop"; reason?: string; unit?: string; index: number };

/** The default option: an approved answer without a choice counts as it. */
const DEFAULT_CHOICE: DependencyChoice = "A";
/** Choices that add a dependency to the plan; D sends the work back or drops it. */
const COUNTED: ReadonlySet<DependencyChoice> = new Set(["A", "B", "C", "split"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isChoice = (v: unknown): v is DependencyChoice => DEPENDENCY_CHOICES.includes(v as DependencyChoice);

type DepResult = { choice: DependencyChoice; request?: string; index: number };

/** The choice of a valid approved `new-dependency` gate comment, or undefined (other gates, other outcomes, unknown choices). */
function resultOf(m: MarkedComment, index: number): DepResult | undefined {
	const d = m.data;
	if (m.kind !== "gate" || !isObject(d) || d.gate !== NEW_DEPENDENCY_GATE || typeof d.outcome !== "string") return undefined;
	if (!validApproval({ outcome: d.outcome as Outcome, superseded: d.superseded === true })) return undefined;
	const choice = d.choice === undefined || d.choice === "" ? DEFAULT_CHOICE : d.choice;
	if (!isChoice(choice)) return undefined;
	return { choice, index, ...(typeof d.request === "string" ? { request: d.request } : {}) };
}

function results(marked: MarkedComment[]): DepResult[] {
	return marked.flatMap((m, i) => {
		const r = resultOf(m, i);
		return r === undefined ? [] : [r];
	});
}

/**
 * `discovered_deps`: the valid approved results choosing A, B, C or split. The cap blocks when the count
 * reached it and no stuck answer that chose an option follows the latest counted result (as `liftsCap`).
 */
export function discoveredDeps(marked: MarkedComment[], cap?: number): { value: number; blocking: boolean } {
	const counted = results(marked).filter((r) => COUNTED.has(r.choice));
	const last = counted.at(-1)?.index ?? -1;
	const lifted = marked.some((m, i) => i > last && liftsCap(m));
	return { value: counted.length, blocking: cap !== undefined && counted.length >= cap && !lifted };
}

/** The drafts the request of `id` stored, read leniently: they are forge data. */
function draftsOf(marked: MarkedComment[], id: string | undefined): Record<string, unknown> {
	if (id === undefined) return {};
	const request = marked.find((m) => m.kind === "request" && m.id === id)?.data;
	const snapshot = isObject(request) ? request.snapshot : undefined;
	const drafts = isObject(snapshot) ? snapshot.drafts : undefined;
	return isObject(drafts) ? drafts : {};
}

function optionD(drafts: Record<string, unknown>): Pick<LatestDependencyChoice, "action" | "reason"> {
	const d = isObject(drafts.d) ? drafts.d : {};
	const action = d.action === "shape" || d.action === "drop" ? { action: d.action as "shape" | "drop" } : {};
	return { ...action, ...(typeof d.reason === "string" ? { reason: d.reason } : {}) };
}

/** The latest valid approved `new-dependency` result, with D's action and reason and the unit from its request. */
export function latestDependencyChoice(marked: MarkedComment[]): LatestDependencyChoice | undefined {
	const latest = results(marked).at(-1);
	if (latest === undefined) return undefined;
	const drafts = draftsOf(marked, latest.request);
	return {
		choice: latest.choice,
		...(latest.choice === "D" ? optionD(drafts) : {}),
		...(typeof drafts.unit === "string" ? { unit: drafts.unit } : {}),
		index: latest.index,
	};
}
