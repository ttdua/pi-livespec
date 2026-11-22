// Completion of the `initiative` gate (design D6): the validator that supersedes a stale approval and
// the effect that writes the tracking issue, the new change issues, the `## Changes` list and the
// edited changes, in that order. Each step finds before it creates and skips a write already made, so
// a rerun after a crash or a version conflict writes nothing twice.

import { parseChange } from "../core/change.ts";
import { appendChange, type Initiative, initiativeBody, insertChangeBefore, parseInitiative, removeChange, setChangeDepends } from "../core/initiative.ts";
import { replaceSection, setHeaderLine } from "../core/sections.ts";
import { gateEffects, registerGate, registerGateEffect, registerGateValidator } from "../engine/gates.ts";
import { LABEL_INITIATIVE, LABEL_LIVESPEC, phaseLabel } from "../forge/labels.ts";
import type { Forge, Issue } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { Answered, RequestRecord } from "../interaction/approver.ts";
import type { CompletionCtx, Run } from "../interaction/complete-effects.ts";
import type { AnswerData } from "../interaction/requests.ts";
import { snapshotOf } from "../interaction/requests.ts";
import { changeBody, dependsValue } from "../core/change-body.ts";
import { type DraftDep, type DraftEntry, createOrder, draftCycle, existingDepends, type InitiativeDrafts, isInitiativeDrafts } from "./drafts.ts";
import { readReferenced, TooManyDependencies } from "./propose-read.ts";
import { initiativeNumber } from "./readiness.ts";

export const INITIATIVE_GATE = "initiative";
export const INITIATIVE_TOOL = "initiative_propose";

const FIRST_PHASE = "shape";

/** Writes `edit(body)` on issue `n` with a version check; skipped when nothing changes. A conflict throws, so the next poll retries. */
async function writeBody(forge: Forge, n: number, edit: (body: string) => string): Promise<void> {
	const issue = await forge.getIssue(n);
	const next = edit(issue.body);
	if (next === issue.body) return;
	const written = await forge.updateIssueBody(n, next, issue.version);
	if (written.status === "conflict") throw new Error(`#${n} changed during the initiative completion (${written.changed.join(", ")}); retry`);
}

const hasInitiative = (issue: Issue, t: number | undefined): boolean => initiativeNumber(parseChange(issue.body)) === t;

/** The open `livespec` change titled `title` in initiative `#initiative` (none when undefined), or a new one in `shape` with `body`. */
export async function findOrCreateChange(forge: Forge, title: string, initiative: number | undefined, body: string): Promise<number> {
	const open = await forge.searchIssues({ labels: [LABEL_LIVESPEC], state: "open" });
	const found = open.find((i) => i.title === title && hasInitiative(i, initiative));
	if (found) return found.number;
	return (await forge.createIssue({ title, body, labels: [LABEL_LIVESPEC, phaseLabel(FIRST_PHASE)] })).number;
}

async function findTracking(forge: Forge, name: string): Promise<Issue | undefined> {
	return (await forge.searchIssues({ labels: [LABEL_INITIATIVE], state: "open" })).find((i) => i.title === name);
}

/** Step 1: the amended tracking issue, the open one titled with the name, or a new one. */
async function trackingIssue(forge: Forge, d: InitiativeDrafts): Promise<number> {
	if (d.amend !== undefined) return d.amend;
	const found = await findTracking(forge, d.name);
	if (found) return found.number;
	return (await forge.createIssue({ title: d.name, body: initiativeBody(d.goal, d.capabilities), labels: [LABEL_INITIATIVE] })).number;
}

/** Turns entry names into issue numbers once their issues exist. */
type Numbers = (d: DraftDep) => number;

/** The numbers of `deps`, without repeats: a name and the number it was created as are one dependency. */
const numbered = (deps: DraftDep[], num: Numbers): number[] => [...new Set(deps.map(num))];

function numbersOf(created: Record<string, number>): Numbers {
	return (d) => {
		if (typeof d === "number") return d;
		const n = created[d];
		if (n === undefined) throw new Error(`initiative entry ${d} has no issue yet`);
		return n;
	};
}

/** Step 2: every new entry, in dependency order. */
async function createEntries(forge: Forge, t: number, ordered: DraftEntry[]): Promise<Record<string, number>> {
	const created: Record<string, number> = {};
	const num = numbersOf(created);
	for (const e of ordered) {
		if (e.number !== undefined) continue;
		const body = changeBody({ initiative: t, depends: (e.depends ?? []).map(num), proposal: e.proposal ?? "" });
		created[e.name] = await findOrCreateChange(forge, e.name, t, body);
	}
	return created;
}

/** Step 3 as a pure edit: new and current entries appended, edited Depends rewritten, removed entries dropped. */
function changesList(body: string, d: InitiativeDrafts, ordered: DraftEntry[], num: Numbers): string {
	let out = body;
	for (const e of ordered) {
		const n = num(e.number ?? e.name);
		const listed = parseInitiative(out).changes.some((c) => c.number === n);
		const depends = e.depends === undefined ? undefined : numbered(e.depends, num);
		const entry = { number: n, name: e.name, depends: depends ?? [] };
		if (listed && depends !== undefined) out = setChangeDepends(out, n, depends);
		else if (!listed && (e.number === undefined || n === d.current)) out = e.before === undefined ? appendChange(out, entry) : insertChangeBefore(out, e.before, entry);
	}
	for (const n of d.remove ?? []) out = removeChange(out, n);
	return out;
}

/** Step 4 as a pure edit of one existing change: its Initiative line (current change), Depends and Proposal. */
function changeEdit(body: string, e: DraftEntry, o: { t: number; current: boolean; num: Numbers }): string {
	let out = o.current && initiativeNumber(parseChange(body)) !== o.t ? setHeaderLine(body, "Initiative", `#${o.t}`) : body;
	if (e.depends !== undefined) out = setHeaderLine(out, "Depends", dependsValue(numbered(e.depends, o.num)));
	if (e.proposal !== undefined) out = replaceSection(out, "Proposal", e.proposal);
	return out;
}

/**
 * Applies approved drafts in design D6 order and returns the tracking issue and the issues it created
 * by entry name. Reused by `new_dependency` option A.
 */
export async function applyInitiative(run: Run, drafts: InitiativeDrafts): Promise<{ tracking: number; created: Record<string, number> }> {
	const forge = run.ctx.forge;
	const t = await trackingIssue(forge, drafts);
	const ordered = createOrder(drafts.entries);
	const created = await createEntries(forge, t, ordered);
	const num = numbersOf(created);
	await writeBody(forge, t, (body) => changesList(body, drafts, ordered, num));
	for (const e of ordered) {
		if (e.number === undefined) continue;
		await writeBody(forge, e.number, (body) => changeEdit(body, e, { t, current: e.number === drafts.current, num }));
	}
	return { tracking: t, created };
}

// --- validation ------------------------------------------------------------------------------------

function draftsOf(req: RequestRecord): InitiativeDrafts | undefined {
	const typed = snapshotOf(req);
	const drafts = typed.kind === "gate" ? typed.snapshot.drafts : undefined;
	return isInitiativeDrafts(drafts) ? drafts : undefined;
}

/** A new entry whose name an open change outside the initiative already has. */
function nameClash(d: InitiativeDrafts, open: Issue[], t: number | undefined): string | undefined {
	for (const e of d.entries) {
		if (e.number !== undefined) continue;
		const taken = open.find((i) => i.title === e.name && (t === undefined || !hasInitiative(i, t)));
		if (taken) return `an open livespec change is already named ${untrusted(e.name)} (#${taken.number})`;
	}
	return undefined;
}

const issueNumbers = (d: InitiativeDrafts, initiative: Initiative | undefined): number[] => {
	const own = d.entries.flatMap((e) => [e.number, ...(e.depends ?? [])]).filter((n): n is number => typeof n === "number");
	return [...new Set([...own, ...(initiative?.changes.map((c) => c.number) ?? [])])];
};

async function cycleNow(forge: Forge, d: InitiativeDrafts, tracking: Issue | undefined): Promise<string | undefined> {
	const initiative = tracking === undefined ? undefined : parseInitiative(tracking.body);
	const read = await readReferenced(forge, issueNumbers(d, initiative));
	const issues = [...read.values()].filter((i): i is Issue => i !== "missing" && i.labels.includes(LABEL_LIVESPEC));
	const cycle = draftCycle(d, existingDepends(issues, initiative));
	return cycle === undefined ? undefined : `the Depends would form a cycle: ${untrusted(cycle)}`;
}

/**
 * Whether open tracking issue `issue` was created by this request's completion (a crash retry adopts it).
 * The tool refuses a taken name, so a same-titled issue appeared after the request. This request's issue
 * holds the drafts' Goal and lists only the drafts' entries; an issue that differs in either is another
 * initiative, whose list the effect must not join.
 */
function createdByRequest(issue: Issue, d: InitiativeDrafts): boolean {
	const parsed = parseInitiative(issue.body);
	const names = new Set(d.entries.map((e) => e.name));
	const goal = parseInitiative(initiativeBody(d.goal, d.capabilities)).goal;
	return parsed.goal === goal && parsed.changes.every((c) => names.has(c.name) || c.number === d.current);
}

function takenName(d: InitiativeDrafts, tracking: Issue | undefined): string | undefined {
	if (d.amend !== undefined || tracking === undefined || createdByRequest(tracking, d)) return undefined;
	return `an open initiative is already named ${untrusted(d.name)} (#${tracking.number})`;
}

async function cycleOrTooMany(forge: Forge, d: InitiativeDrafts, tracking: Issue | undefined): Promise<string | undefined> {
	try {
		return await cycleNow(forge, d, tracking);
	} catch (error) {
		if (error instanceof TooManyDependencies) return error.message;
		throw error;
	}
}

/** Supersedes an approval whose names are taken (by a change outside the initiative or another initiative), or whose graph now has a cycle. */
async function validateInitiative(ctx: CompletionCtx, req: RequestRecord, ans: Answered): Promise<string | undefined> {
	if (ans.outcome !== "approved" && ans.outcome !== "approved_with_notes") return undefined;
	const d = draftsOf(req);
	if (!d) return "the request holds no initiative drafts";
	const tracking = d.amend !== undefined ? await ctx.forge.getIssue(d.amend) : await findTracking(ctx.forge, d.name);
	const taken = takenName(d, tracking);
	if (taken !== undefined) return taken;
	const open = await ctx.forge.searchIssues({ labels: [LABEL_LIVESPEC], state: "open" });
	return nameClash(d, open, tracking?.number) ?? (await cycleOrTooMany(ctx.forge, d, tracking));
}

async function initiativeEffect(run: Run, record: AnswerData): Promise<void> {
	const d = draftsOf(record.request);
	if (!d) throw new Error(`${record.request.id} holds no initiative drafts`);
	await applyInitiative(run, d);
}

/** Registers the `initiative` gate with its validator and effect; called with the tool registration. */
export function registerInitiativeGate(): void {
	registerGate(INITIATIVE_GATE, { checks: [], proposer: INITIATIVE_TOOL });
	registerGateValidator(INITIATIVE_GATE, validateInitiative);
	// Effects accumulate, and every tool registration calls this: add the effect once.
	if (!gateEffects(INITIATIVE_GATE).includes(initiativeEffect)) registerGateEffect(INITIATIVE_GATE, initiativeEffect);
}
