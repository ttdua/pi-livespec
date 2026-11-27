// The `new-dependency` gate (spec discovered-dependencies "New dependency tool", design D9): the drafts the
// tool sends, the options it offers, the pure refusals over what the tool read, and the review summary.
// Forge text in refusals and the summary is wrapped as untrusted.

import { isKebabName } from "../core/names.ts";
import { DEPENDENCY_CHOICES, NEW_DEPENDENCY_GATE } from "../engine/deps-facts.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { LABEL_LIVESPEC } from "../forge/labels.ts";
import type { Issue } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { RequestOption } from "../interaction/approver.ts";
import { findCycle, formatCycle } from "../initiatives/graph.ts";

export { NEW_DEPENDENCY_GATE } from "../engine/deps-facts.ts";
export const NEW_DEPENDENCY_TOOL = "new_dependency";

/** The tool's input and the request's drafts: one drafted proposal per option (design D9). */
export type NewDependencyDrafts = {
	unit?: string;
	evidence: string;
	a: { name: string; proposal: string; depends: number[] };
	b: { units: string[]; summary: string };
	c: { summary: string; follow_up: { name: string; proposal: string } };
	d: { action: "shape" | "drop"; reason: string };
};

/** The initiative option A creates for change `title` when the change is in none (`<change>-deps`). */
export const depsInitiativeName = (title: string): string => `${title}-deps`;

/** Option A's graph edges: the drafted prerequisite is a node by name, every existing change by number. */
type Node = number | string;

/** The gate's registered options, in the order the request offers them; A is the default. */
export const NEW_DEPENDENCY_OPTIONS: (RequestOption & { description: string })[] = [
	{ id: "A", label: "A: create the prerequisite change and park this one until it merges", description: "Creates the prerequisite change in shape, lists it in an initiative, and parks this change until it merges." },
	{ id: "B", label: "B: add the missing work to this change as new units (unit_amend --add)", description: "Changes nothing now; the missing work is added to this change as new units with unit_amend --add." },
	{ id: "C", label: "C: stub the missing part now and create a follow-up change", description: "Creates a follow-up change in shape for the missing part; this change stubs it with unit_amend." },
	{ id: "D", label: "D: send the change back to shape, or drop it", description: "Sends the change back to shape (marking later phases stale), or leaves it to be closed as abandoned." },
	{ id: "split", label: "split: ship the finished units and move the rest to a new change (change_split)", description: "Changes nothing now; the units not done move to a new change with change_split." },
];

const SPLIT = "split";

/** A, B, C and D, plus `split` when at least one unit is done and one is not. */
export function offeredOptions(state: ChangeState): RequestOption[] {
	const units = state.change.units;
	const boundary = units.some((u) => u.done) && units.some((u) => !u.done);
	return NEW_DEPENDENCY_OPTIONS.filter((o) => o.id !== SPLIT || boundary);
}

// --- input -----------------------------------------------------------------------------------------

const ISSUE_REF = /^#(\d+)$/;
const ACTIONS = new Set(["shape", "drop"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** The raw params as the plan reads them: `a.depends` keeps its `#<n>` strings for the plan to resolve. */
export type NewDependencyInput = Omit<NewDependencyDrafts, "a" | "d"> & { a: { name: string; proposal: string; depends: string[] }; d: { action: string; reason: string } };

/** Normalizes the params; the schema is the trust boundary, this only fills absent fields. */
export function inputOf(p: unknown): NewDependencyInput {
	const o = isObject(p) ? p : {};
	const a = isObject(o.a) ? o.a : {};
	const b = isObject(o.b) ? o.b : {};
	const c = isObject(o.c) ? o.c : {};
	const follow = isObject(c.follow_up) ? c.follow_up : {};
	const d = isObject(o.d) ? o.d : {};
	return {
		...(typeof o.unit === "string" && o.unit !== "" ? { unit: o.unit } : {}),
		evidence: text(o.evidence),
		a: { name: text(a.name), proposal: text(a.proposal), depends: strings(a.depends) },
		b: { units: strings(b.units), summary: text(b.summary) },
		c: { summary: text(c.summary), follow_up: { name: text(follow.name), proposal: text(follow.proposal) } },
		d: { action: text(d.action), reason: text(d.reason) },
	};
}

/** The issue numbers option A names, for the tool to read before planning. */
export function referencedNumbers(input: NewDependencyInput): number[] {
	return [...new Set(input.a.depends.flatMap((d) => [...d.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))))];
}

// --- plan ------------------------------------------------------------------------------------------

/**
 * What the tool read: the open livespec changes (for name clashes), every issue option A names followed
 * through their `Depends`, the current change's dependency edges (its line united with its entry), and,
 * outside an initiative, the open initiative already named as the one option A would create.
 */
export type NewDependencyCtx = { open: Issue[]; referenced: Map<number, Issue | "missing">; graph: Map<number, number[]>; depsTaken?: Issue };

class Refusal extends Error {}
const refuse = (message: string): never => {
	throw new Refusal(message);
};

function checkNewChange(ctx: NewDependencyCtx, label: string, name: string, proposal: string): void {
	if (!isKebabName(name)) refuse(`${label}'s change name must be kebab-case: got ${untrusted(name)}.`);
	if (proposal.trim() === "") refuse(`${label}'s Proposal is empty.`);
	if (/^## /m.test(proposal)) refuse(`${label}'s Proposal has a level-2 heading; keep it short.`);
	const taken = ctx.open.find((i) => i.title === name && i.labels.includes(LABEL_LIVESPEC));
	if (taken) refuse(`An open livespec change is already named ${untrusted(name)}: #${taken.number}.`);
}

function resolveDepends(ctx: NewDependencyCtx, depends: string[]): number[] {
	return [
		...new Set(
			depends.map((d) => {
				const ref = ISSUE_REF.exec(d.trim()) ?? refuse(`Option A's Depends takes #<n> of existing changes: got ${untrusted(d)}.`);
				const n = Number(ref[1]);
				const issue = ctx.referenced.get(n);
				if (issue === undefined || issue === "missing" || !issue.labels.includes(LABEL_LIVESPEC)) refuse(`#${n} in option A's Depends is not a livespec change issue.`);
				return n;
			}),
		),
	];
}

/** The cycle option A would create: the prerequisite named `name` depends on `depends`, and the current change on it. */
export function optionACycle(graph: Map<number, number[]>, current: number, name: string, depends: number[]): string | undefined {
	const g = new Map<Node, Node[]>(graph);
	g.set(name, [...depends]);
	g.set(current, [...(graph.get(current) ?? []), name]);
	const cycle = findCycle(g);
	return cycle === undefined ? undefined : formatCycle(cycle);
}

function checkUnits(state: ChangeState, input: NewDependencyInput): void {
	if (input.unit !== undefined && !state.change.units.some((u) => u.id === input.unit)) refuse(`${untrusted(input.unit)} is not a unit of the change.`);
	if (input.evidence.trim() === "") refuse("The evidence is empty.");
	if (input.b.units.length === 0) refuse("Option B lists no units to add.");
	if (!ACTIONS.has(input.d.action)) refuse(`Option D's action must be shape or drop: got ${untrusted(input.d.action)}.`);
	if (input.d.reason.trim() === "") refuse("Option D's reason is empty.");
}

export type PlanResult = { drafts: NewDependencyDrafts } | { refused: string };

/** The drafts of a `new-dependency` request, or why the tool refuses; pure over what the tool read. */
export function planNewDependency(input: NewDependencyInput, state: ChangeState, ctx: NewDependencyCtx): PlanResult {
	try {
		checkUnits(state, input);
		if (ctx.depsTaken) refuse(`Option A would create the initiative ${untrusted(ctx.depsTaken.title)}, but an open initiative already has that name: #${ctx.depsTaken.number}.`);
		checkNewChange(ctx, "Option A", input.a.name, input.a.proposal);
		checkNewChange(ctx, "Option C", input.c.follow_up.name, input.c.follow_up.proposal);
		if (input.a.name === input.c.follow_up.name) refuse("Options A and C name the same new change.");
		const depends = resolveDepends(ctx, input.a.depends);
		const cycle = optionACycle(ctx.graph, state.issue.number, input.a.name, depends);
		if (cycle !== undefined) refuse(`Option A's Depends would form a cycle: ${untrusted(cycle)}.`);
		const d = { action: input.d.action as "shape" | "drop", reason: input.d.reason };
		return { drafts: { ...input, a: { ...input.a, depends }, d } };
	} catch (error) {
		if (error instanceof Refusal) return { refused: error.message };
		throw error;
	}
}

// --- summary and stored drafts ----------------------------------------------------------------------

const indent = (s: string): string[] => s.split("\n").map((l) => `  ${l}`);
const dependsText = (d: number[]): string => (d.length === 0 ? "—" : d.map((n) => `#${n}`).join(", "));

/** The review payload: the evidence and each option's draft, all wrapped as untrusted; A without an initiative names the initiative it creates. */
export function newDependencySummary(d: NewDependencyDrafts, state: ChangeState, options: RequestOption[], initiative: number | undefined): string {
	const title = state.issue.title;
	const where = initiative === undefined ? `a new initiative ${untrusted(depsInitiativeName(title))} listing it, then #${state.issue.number}` : `initiative #${initiative}, before #${state.issue.number}`;
	const lines = [
		`New dependency${d.unit === undefined ? "" : ` found by ${untrusted(d.unit)}`}.`,
		`Evidence: ${untrusted(d.evidence)}`,
		`A: create ${untrusted(d.a.name)} in shape — Depends: ${dependsText(d.a.depends)} — in ${where}; park #${state.issue.number}.`,
		...indent(untrusted(d.a.proposal)),
		`B: add units ${untrusted(d.b.units.join(", "))} with unit_amend --add.`,
		...indent(untrusted(d.b.summary)),
		`C: stub with unit_amend, follow-up change ${untrusted(d.c.follow_up.name)}.`,
		...indent(untrusted(d.c.summary)),
		...indent(untrusted(d.c.follow_up.proposal)),
		`D: ${d.d.action === "shape" ? "back to shape" : "drop the change"} — ${untrusted(d.d.reason)}`,
	];
	const split = options.some((o) => o.id === SPLIT) ? ["split: move the units not done to a new change with change_split."] : [];
	return [...lines, ...split].join("\n");
}

/** Whether a stored snapshot's drafts have the new-dependency shape; the snapshot is forge data. */
export function isNewDependencyDrafts(v: unknown): v is NewDependencyDrafts {
	if (!isObject(v) || typeof v.evidence !== "string" || (v.unit !== undefined && typeof v.unit !== "string")) return false;
	const { a, b, c, d } = v;
	if (!isObject(a) || typeof a.name !== "string" || typeof a.proposal !== "string" || !Array.isArray(a.depends) || !a.depends.every((n) => typeof n === "number")) return false;
	if (!isObject(b) || !Array.isArray(b.units) || typeof b.summary !== "string") return false;
	if (!isObject(c) || typeof c.summary !== "string" || !isObject(c.follow_up) || typeof c.follow_up.name !== "string" || typeof c.follow_up.proposal !== "string") return false;
	return isObject(d) && typeof d.action === "string" && ACTIONS.has(d.action) && typeof d.reason === "string";
}

/** A known choice of the answer; an approved answer with no choice is A, the default. */
export function answerChoice(choice: string | undefined): (typeof DEPENDENCY_CHOICES)[number] | undefined {
	const c = choice === undefined || choice === "" ? "A" : choice;
	return DEPENDENCY_CHOICES.find((x) => x === c);
}
