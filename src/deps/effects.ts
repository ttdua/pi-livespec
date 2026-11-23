// Completion of the `new-dependency` gate (spec "New dependency options", design D9): the effect of the
// chosen option, run before the `gate` comment, and the validator that supersedes a stale approval. Each
// step finds before it creates (through `applyInitiative` / `findOrCreateChange`), so a rerun after a
// crash writes nothing twice.

import { changeBody } from "../core/change-body.ts";
import { parseChange } from "../core/change.ts";
import { parseInitiative } from "../core/initiative.ts";
import { advancePhase } from "../engine/advance.ts";
import { discoveredDeps } from "../engine/deps-facts.ts";
import { LABEL_LIVESPEC } from "../forge/labels.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { Answered, RequestRecord } from "../interaction/approver.ts";
import { type CompletionCtx, phasesAfter, postOnce, readIssue, type Run } from "../interaction/complete-effects.ts";
import { type AnswerData, snapshotOf } from "../interaction/requests.ts";
import { staleComment } from "../interaction/stale.ts";
import { applyInitiative, findOrCreateChange, findTracking, takenInitiative } from "../initiatives/complete.ts";
import type { DraftEntry, InitiativeDrafts } from "../initiatives/drafts.ts";
import { TooManyDependencies } from "../initiatives/propose-read.ts";
import { dependencyNumbers, initiativeNumber } from "../initiatives/readiness.ts";
import { answerChoice, depsInitiativeName, isNewDependencyDrafts, type NewDependencyDrafts, optionACycle } from "./new-dependency.ts";
import { readDependencyCtx } from "./read.ts";

const SHAPE = "shape";

export function draftsOf(req: RequestRecord): NewDependencyDrafts | undefined {
	const typed = snapshotOf(req);
	const drafts = typed.kind === "gate" ? typed.snapshot.drafts : undefined;
	return isNewDependencyDrafts(drafts) ? drafts : undefined;
}

/**
 * Option A as initiative drafts for `applyInitiative`: inside an initiative, an amendment adding the prerequisite
 * before the change's entry; otherwise a new `<change>-deps` initiative listing the prerequisite, then the change.
 * Either way the change's `Depends` (line and entry) gains the prerequisite, beside what it already has.
 */
export function optionADrafts(d: NewDependencyDrafts, change: { number: number; title: string; body: string }, tracking?: { number: number; title: string; body: string }): InitiativeDrafts {
	const current = change.number;
	const prerequisite: DraftEntry = { name: d.a.name, proposal: d.a.proposal, depends: [...d.a.depends], ...(tracking === undefined ? {} : { before: current }) };
	const p = tracking === undefined ? undefined : parseInitiative(tracking.body);
	const entry = p?.changes.find((c) => c.number === current);
	const depends = dependencyNumbers({ issue: { number: current }, change: parseChange(change.body) }, p);
	const self: DraftEntry = { name: entry?.name ?? change.title, number: current, depends: [...depends, d.a.name] };
	if (tracking === undefined || p === undefined) return { name: depsInitiativeName(change.title), goal: `Prerequisites of #${current} ${change.title}`, capabilities: [], current, entries: [prerequisite, self] };
	return { name: tracking.title, goal: p.goal, capabilities: [...p.capabilities], current, amend: tracking.number, entries: [prerequisite, self] };
}

async function applyA(run: Run, d: NewDependencyDrafts, request: string): Promise<void> {
	const issue = await readIssue(run);
	const t = initiativeNumber(parseChange(issue.body));
	const tracking = t === undefined ? undefined : await run.ctx.forge.getIssue(t);
	await applyInitiative(run, optionADrafts(d, issue, tracking), request);
}

/** Option C: the follow-up change in `shape`, with no `Depends`, outside any initiative. */
async function applyC(run: Run, d: NewDependencyDrafts): Promise<void> {
	await findOrCreateChange(run.ctx.forge, d.c.follow_up.name, undefined, changeBody({ depends: [], proposal: d.c.follow_up.proposal }));
}

/** Option D `shape`: a `stale` listing `shape` and every later phase (no counted iteration), then the label move. */
async function applyDShape(run: Run, record: AnswerData, d: NewDependencyDrafts): Promise<void> {
	const id = `stale.new-dependency.${record.request.id}`;
	const phases = [SHAPE, ...phasesAfter(run.ctx.pack, SHAPE)];
	await postOnce(run, "stale", id, staleComment(id, { reason: `new-dependency D: ${d.d.reason}`, phases }));
	const moved = await advancePhase(run.ctx.forge, run.ctx.issue, SHAPE, run.ctx.pack);
	if (moved.status === "refused") throw new Error(`cannot move #${run.ctx.issue} to ${SHAPE}: ${moved.reason}`);
}

/** Applies the chosen option of a valid approved answer; B, D `drop` and `split` write nothing. */
export async function newDependencyEffect(run: Run, record: AnswerData): Promise<void> {
	const d = draftsOf(record.request);
	if (!d) throw new Error(`${record.request.id} holds no new-dependency drafts`);
	const choice = answerChoice(record.answer.choice);
	if (choice === "A") await applyA(run, d, record.request.id);
	else if (choice === "C") await applyC(run, d);
	else if (choice === "D" && d.d.action === "shape") await applyDShape(run, record, d);
}

// --- validation ------------------------------------------------------------------------------------

/** Option A outside an initiative: an open initiative with the generated name that this request did not create. */
async function initiativeTaken(ctx: CompletionCtx, req: RequestRecord): Promise<string | undefined> {
	const issue = await ctx.forge.getIssue(ctx.issue);
	if (initiativeNumber(parseChange(issue.body)) !== undefined) return undefined;
	const name = depsInitiativeName(issue.title);
	return takenInitiative(name, await findTracking(ctx.forge, name), req.id);
}

async function cycleNow(ctx: CompletionCtx, d: NewDependencyDrafts): Promise<string | undefined> {
	const issue = await ctx.forge.getIssue(ctx.issue);
	try {
		const read = await readDependencyCtx(ctx.forge, issue, parseChange(issue.body), d.a.depends);
		const cycle = optionACycle(read.graph, issue.number, d.a.name, d.a.depends);
		return cycle === undefined ? undefined : `option A's Depends would form a cycle: ${untrusted(cycle)}`;
	} catch (error) {
		if (error instanceof TooManyDependencies) return error.message;
		throw error;
	}
}

/** The change option A or C would create, when an open livespec change took its name since the request. */
async function nameTaken(ctx: CompletionCtx, name: string): Promise<string | undefined> {
	const taken = (await ctx.forge.searchIssues({ labels: [LABEL_LIVESPEC], state: "open" })).find((i) => i.title === name);
	return taken === undefined ? undefined : `an open livespec change is already named ${untrusted(name)} (#${taken.number})`;
}

/**
 * Supersedes an approval that no longer holds: an unknown choice, a counted choice while the cap blocks
 * (another result was approved meanwhile), a new change's name taken meanwhile (the effect would adopt
 * that change), option A's generated initiative name taken by an initiative this request did not create,
 * or option A now forming a cycle. Other outcomes pass. It runs once, before any effect.
 */
export async function validateNewDependency(ctx: CompletionCtx, req: RequestRecord, ans: Answered): Promise<string | undefined> {
	if (ans.outcome !== "approved" && ans.outcome !== "approved_with_notes") return undefined;
	const d = draftsOf(req);
	if (!d) return "the request holds no new-dependency drafts";
	const choice = answerChoice(ans.choice);
	if (choice === undefined) return `${untrusted(ans.choice ?? "")} is not an option of the new-dependency gate`;
	if (choice !== "D" && discoveredDeps(ctx.marked, ctx.pack.loops.discovered_deps).blocking) return "discovered_deps reached its cap: send a stuck report with spec_stuck";
	if (choice === "C") return nameTaken(ctx, d.c.follow_up.name);
	if (choice !== "A") return undefined;
	return (await nameTaken(ctx, d.a.name)) ?? (await initiativeTaken(ctx, req)) ?? (await cycleNow(ctx, d));
}
