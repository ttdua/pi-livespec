// Pure planning of `initiative_propose` (spec "Initiative propose tool", "Initiative amendment"):
// validates the input against the forge state the tool read and builds the gate drafts. A new
// initiative needs the current change in `shape`; an amendment edits the initiative the change names.

import { parseChange } from "../core/change.ts";
import { type Initiative, parseInitiative } from "../core/initiative.ts";
import { isKebabName } from "../core/names.ts";
import { sectionText } from "../core/sections.ts";
import type { DepState } from "../engine/deps-facts.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { LABEL_INITIATIVE, LABEL_LIVESPEC } from "../forge/labels.ts";
import type { Issue } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { type DraftDep, type DraftEntry, draftCycle, existingDepends, type InitiativeDrafts } from "./drafts.ts";
import { initiativeNumber } from "./readiness.ts";

export type InitiativeEntryInput = { name: string; proposal: string; depends: string[] };
export type InitiativeInput = { name: string; goal: string; capabilities: string[]; entries: InitiativeEntryInput[]; remove?: string[] };

/**
 * What the tool read: the open `livespec` and `livespec:initiative` issues, every issue the input or the amended initiative names
 * (the tracking issue included; `missing` when it does not exist), and the dependency state of the
 * issues an amendment removes.
 */
export type PlanCtx = {
	open: Issue[];
	referenced: Map<number, Issue | "missing">;
	states?: Map<number, DepState>;
};

export type PlanResult = { drafts: InitiativeDrafts } | { refused: string };

class Refusal extends Error {}
const refuse = (message: string): never => {
	throw new Refusal(message);
};

const SHAPE = "shape";
const ISSUE_REF = /^#(\d+)$/;
const REMOVE_DEP = /^#(\d+):#(\d+)$/;
const name = (s: string): string => untrusted(s);

/** What resolves the names of one plan: entry names to their node, and the existing changes by number. */
type Scope = { nodes: Map<string, DraftDep>; ctx: PlanCtx };

function livespecIssue(ctx: PlanCtx, n: number): Issue | undefined {
	const issue = ctx.referenced.get(n);
	return issue !== undefined && issue !== "missing" && issue.labels.includes(LABEL_LIVESPEC) ? issue : undefined;
}

function resolveDep(scope: Scope, entry: string, dep: string): DraftDep {
	const ref = ISSUE_REF.exec(dep.trim());
	if (ref) {
		const n = Number(ref[1]);
		if (!livespecIssue(scope.ctx, n)) refuse(`#${n} in the Depends of ${name(entry)} is not a livespec change issue.`);
		return n;
	}
	const node = scope.nodes.get(dep.trim());
	return node ?? refuse(`${name(entry)} depends on ${name(dep)}, which is neither an entry nor #<n> of a change.`);
}

const resolveDeps = (scope: Scope, e: InitiativeEntryInput): DraftDep[] => [...new Set(e.depends.map((d) => resolveDep(scope, e.name, d)))];

function checkNames(input: InitiativeInput): void {
	if (!isKebabName(input.name)) refuse(`The initiative name must be kebab-case: got ${name(input.name)}.`);
	const seen = new Set<string>();
	for (const e of input.entries) {
		if (!isKebabName(e.name)) refuse(`The entry name must be kebab-case: got ${name(e.name)}.`);
		if (seen.has(e.name)) refuse(`The entry ${name(e.name)} is listed twice.`);
		seen.add(e.name);
	}
}

function checkProposal(e: InitiativeEntryInput): void {
	if (e.proposal.trim() === "") refuse(`The Proposal of ${name(e.name)} is empty.`);
	if (/^## /m.test(e.proposal)) refuse(`The Proposal of ${name(e.name)} has a level-2 heading; keep it short.`);
}

function checkFreeName(ctx: PlanCtx, current: number, entry: string): void {
	const taken = ctx.open.find((i) => i.title === entry && i.number !== current && i.labels.includes(LABEL_LIVESPEC));
	if (taken) refuse(`An open livespec change is already named ${name(entry)}: #${taken.number}.`);
}

function checkCycle(drafts: InitiativeDrafts, ctx: PlanCtx, initiative?: Initiative): InitiativeDrafts {
	const issues = [...ctx.referenced.values()].filter((i): i is Issue => i !== "missing" && i.labels.includes(LABEL_LIVESPEC));
	const cycle = draftCycle(drafts, existingDepends(issues, initiative));
	return cycle === undefined ? drafts : refuse(`The Depends form a cycle: ${untrusted(cycle)}.`);
}

// --- a new initiative ----------------------------------------------------------------------------

function planNew(input: InitiativeInput, state: ChangeState, ctx: PlanCtx): InitiativeDrafts {
	const current = state.issue.number;
	const title = state.issue.title;
	if (state.phase.kind !== "ok" || state.phase.id !== SHAPE) refuse(`initiative_propose runs in ${SHAPE}, or on a change that already has an Initiative line.`);
	if ((input.remove ?? []).length > 0) refuse("remove only applies to an amendment of an existing initiative.");
	const taken = ctx.open.find((i) => i.title === input.name && i.labels.includes(LABEL_INITIATIVE));
	if (taken) refuse(`An open initiative is already named ${name(input.name)}: #${taken.number}; amend it from one of its changes or pick another name.`);
	if (input.entries.filter((e) => e.name === title).length !== 1) refuse(`Exactly one entry must be the current change ${name(title)}.`);
	const nodes = new Map<string, DraftDep>(input.entries.map((e) => [e.name, e.name === title ? current : e.name]));
	const scope: Scope = { nodes, ctx };
	const entries = input.entries.map((e): DraftEntry => {
		checkProposal(e);
		if (e.name !== title) checkFreeName(ctx, current, e.name);
		const base = { name: e.name, proposal: e.proposal, depends: resolveDeps(scope, e) };
		return e.name === title ? { name: e.name, number: current, proposal: base.proposal, depends: base.depends } : base;
	});
	return checkCycle({ name: input.name, goal: input.goal, capabilities: [...input.capabilities], current, entries }, ctx);
}

// --- an amendment ----------------------------------------------------------------------------------

type Amend = { scope: Scope; initiative: Initiative; existing: Map<number, number[]>; current: number };

/** The existing change an input entry names: an entry of the initiative, or the current change. */
function existingNumber(a: Amend, entry: string, title: string): number | undefined {
	return a.initiative.changes.find((c) => c.name === entry)?.number ?? (entry === title ? a.current : undefined);
}

const sameSet = (a: DraftDep[], b: DraftDep[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

function proposalEdit(issue: Issue, e: InitiativeEntryInput): string | undefined {
	if (e.proposal.trim() === "" || e.proposal.trim() === (sectionText(issue.body, "Proposal") ?? "").trim()) return undefined;
	checkProposal(e);
	if (parseChange(issue.body).units.length > 0) refuse(`${name(e.name)} already has units: change its plan with change_split or unit_amend instead.`);
	return e.proposal;
}

function dependsEdit(a: Amend, issue: Issue, e: InitiativeEntryInput, n: number): DraftDep[] | undefined {
	const next = resolveDeps(a.scope, e);
	if (sameSet(next, a.existing.get(n) ?? [])) return undefined;
	if (parseChange(issue.body).header.branch !== undefined) refuse(`${name(e.name)} has a Branch line: its Depends can only lose an abandoned dependency.`);
	return next;
}

function existingEdit(a: Amend, e: InitiativeEntryInput, n: number): DraftEntry | undefined {
	const issue = livespecIssue(a.scope.ctx, n) ?? refuse(`#${n} ${name(e.name)} is not a livespec change issue.`);
	const proposal = proposalEdit(issue, e);
	const depends = dependsEdit(a, issue, e, n);
	if (proposal === undefined && depends === undefined) return undefined;
	return { name: e.name, number: n, ...(proposal === undefined ? {} : { proposal }), ...(depends === undefined ? {} : { depends }) };
}

const isAbandoned = (ctx: PlanCtx, n: number): boolean => ctx.states?.get(n) === "abandoned";

/** Removes abandoned dependency `dep` from change `n`, on top of any edit of `n` the entries already made. */
function removeDependency(a: Amend, entries: DraftEntry[], n: number, dep: number): DraftEntry[] {
	const issue = livespecIssue(a.scope.ctx, n);
	if (!issue || issue.state !== "open") refuse(`#${n} is not an open livespec change.`);
	const had = entries.find((x) => x.number === n);
	const deps = had?.depends ?? a.existing.get(n) ?? [];
	if (!deps.includes(dep)) refuse(`#${n} does not depend on #${dep}.`);
	if (!isAbandoned(a.scope.ctx, dep)) refuse(`#${dep} is not abandoned: only an abandoned dependency can be removed.`);
	const entryName = a.initiative.changes.find((c) => c.number === n)?.name ?? (issue as Issue).title;
	const edited: DraftEntry = { ...(had ?? { name: entryName, number: n }), depends: deps.filter((d) => d !== dep) };
	return had ? entries.map((x) => (x === had ? edited : x)) : [...entries, edited];
}

function removedEntry(a: Amend, n: number): number {
	if (!a.initiative.changes.some((c) => c.number === n)) refuse(`#${n} is not an entry of the initiative.`);
	if (!isAbandoned(a.scope.ctx, n)) refuse(`#${n} is not abandoned: only an abandoned change's entry can be removed.`);
	return n;
}

function applyRemovals(a: Amend, entries: DraftEntry[], remove: string[]): { entries: DraftEntry[]; removed: number[] } {
	let out = entries;
	const removed: number[] = [];
	for (const r of remove) {
		const dep = REMOVE_DEP.exec(r.trim());
		const ref = ISSUE_REF.exec(r.trim());
		if (dep) out = removeDependency(a, out, Number(dep[1]), Number(dep[2]));
		else if (ref) removed.push(removedEntry(a, Number(ref[1])));
		else refuse(`remove takes #<n> or #<change>:#<dependency>: got ${name(r)}.`);
	}
	return { entries: out, removed };
}

function trackingOf(ctx: PlanCtx, t: number): { issue: Issue; parsed: Initiative } {
	const issue = ctx.referenced.get(t);
	if (issue === undefined || issue === "missing") return refuse(`The initiative #${t} of this change cannot be read.`);
	return { issue, parsed: parseInitiative(issue.body) };
}

function planAmendment(input: InitiativeInput, state: ChangeState, ctx: PlanCtx, t: number): InitiativeDrafts {
	const tracking = trackingOf(ctx, t);
	const current = state.issue.number;
	const title = state.issue.title;
	const nodes = new Map<string, DraftDep>([...tracking.parsed.changes.map((c): [string, DraftDep] => [c.name, c.number]), [title, current]]);
	for (const e of input.entries) if (!nodes.has(e.name)) nodes.set(e.name, e.name);
	const issues = [...ctx.referenced.values()].filter((i): i is Issue => i !== "missing" && i.labels.includes(LABEL_LIVESPEC));
	const a: Amend = { scope: { nodes, ctx }, initiative: tracking.parsed, existing: existingDepends(issues, tracking.parsed), current };
	const edited = input.entries.flatMap((e): DraftEntry[] => {
		const n = existingNumber(a, e.name, title);
		if (n !== undefined) return [existingEdit(a, e, n)].filter((x): x is DraftEntry => x !== undefined);
		checkProposal(e);
		checkFreeName(ctx, current, e.name);
		return [{ name: e.name, proposal: e.proposal, depends: resolveDeps(a.scope, e) }];
	});
	const { entries, removed } = applyRemovals(a, edited, input.remove ?? []);
	if (entries.length === 0 && removed.length === 0) refuse(`The amendment changes nothing in initiative #${t}.`);
	const p = tracking.parsed;
	const drafts: InitiativeDrafts = { name: tracking.issue.title, goal: p.goal, capabilities: [...p.capabilities], current, amend: t, entries, ...(removed.length > 0 ? { remove: removed } : {}) };
	return checkCycle(drafts, ctx, p);
}

/** The drafts of an `initiative` request, or why the tool refuses; pure over what the tool read. */
export function planInitiative(input: InitiativeInput, state: ChangeState, ctx: PlanCtx): PlanResult {
	try {
		checkNames(input);
		const t = initiativeNumber(state.change);
		return { drafts: t === undefined ? planNew(input, state, ctx) : planAmendment(input, state, ctx, t) };
	} catch (error) {
		if (error instanceof Refusal) return { refused: error.message };
		throw error;
	}
}

/** Every issue number the input names, for the tool to read before planning. */
export function referencedNumbers(input: InitiativeInput): number[] {
	const deps = input.entries.flatMap((e) => e.depends).flatMap((d) => [...d.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
	const removes = (input.remove ?? []).flatMap((r) => [...r.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
	return [...new Set([...deps, ...removes])];
}
