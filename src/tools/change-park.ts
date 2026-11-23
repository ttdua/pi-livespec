// `change_park` (design D13, spec discovered-dependencies "Park tool"): after the new-dependency gate chose A,
// every in-progress unit with work gets a wip branch `<Branch>--wip-<unit>` in its worktree, committed and
// pushed through `guardedPush` (the refspec comes from the issue's Branch line and the unit id only). Then the
// open lanes close as `parked`, the label is added and the `parked` record is posted last, so a crash before it
// leaves the change unparked and a rerun completes the park: an existing wip branch is reused and re-pushed.
// A wip branch already merged into the change branch (left by `change_resume`) is not reused: the unit parks
// from its current HEAD, which contains it, so the push fast-forwards the remote wip branch.

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../core/messages.ts";
import { latestDependencyChoice, type ParkedUnit } from "../engine/deps-facts.ts";
import { createGit, type Git, GitError } from "../engine/git.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { parkedComment, wipBranch } from "../deps/parked.ts";
import { withEvidenceLock } from "../evidence/lock.ts";
import { LABEL_PARKED } from "../forge/labels.ts";
import { guardedPush } from "../guard/push.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { changeDependencies, DependencyReadError } from "../initiatives/readiness.ts";
import { laneComment, type LaneRecord, latestLaneClose } from "../subagents/state.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

export type ChangeParkDetails = { units?: ParkedUnit[] };

const TOOL = "change_park";
const REMOTE = "origin";
const PARKED_KIND = "parked";
/** Unit ids that may reach `wipBranch` and the refspec; lane records naming anything else are ignored. */
const UNIT_ID = /^U\d+$/;

/** An in-progress unit: where its work lives (`root` undefined when its lane worktree is gone) and its pre SHA. */
type InProgress = { unit: string; lane?: LaneRecord; open: boolean; root?: string; pre: string };

/** The parent session's change branch, its git, the issue number and the prerequisite it waits for. */
type Park = { w: WriteContext; state: ChangeState; branch: string; git: Git; prereq: number[] };

class ParkRefusal extends Error {}

const refuse = (message: string): ToolResult<ChangeParkDetails> => toolResult(`${TOOL} refused: ${message}`, {}, true);

// --- refusals --------------------------------------------------------------------

function stateRefusal(state: ChangeState): string | undefined {
	if (state.stale) return "the change state is stale (forge unreachable or login unknown); retry when the forge is reachable.";
	const branch = state.change.header.branch;
	if (branch === undefined || state.git.branch !== branch) return `run it on the change branch${branch === undefined ? "" : ` ${untrusted(branch)}`}; HEAD is on ${untrusted(state.git.branch || "(detached)")}.`;
	const latest = latestDependencyChoice(state.marked);
	if (latest?.choice !== "A") return "the latest approved new-dependency result did not choose A; only option A parks the change.";
	if (state.marked.some((m, i) => i > latest.index && m.kind === PARKED_KIND)) return "the change is already parked for that new-dependency result; resume it with change_resume.";
	return undefined;
}

/** The dependencies that are not merged: the prerequisite option A added, and any other still open. */
async function waitedFor(w: WriteContext, state: ChangeState): Promise<number[] | { refused: string }> {
	try {
		const deps = await changeDependencies(w.forge, { issue: { number: state.issue.number }, change: state.change });
		return deps.filter((d) => d.state !== "merged").map((d) => d.number);
	} catch (error) {
		if (!(error instanceof DependencyReadError)) throw error;
		return { refused: `#${error.number}, a dependency of #${state.issue.number}, cannot be read fresh from the forge; retry once it can be read.` };
	}
}

// --- in-progress units -------------------------------------------------------------

/**
 * Every unit to park, in unit order, then lanes of ids not in `Units`: open lanes, lanes this park already
 * closed (a crash before the record), and units started in the change worktree. A lane's root is its path
 * while that exists; `open` says whether its closed record is still to post.
 */
function inProgress(state: ChangeState, cwd: string): InProgress[] {
	const choice = latestDependencyChoice(state.marked)?.index ?? -1;
	const ids = [...new Set([...state.change.units.map((u) => u.id), ...Object.keys(state.subagents.lanes)])].filter((id) => UNIT_ID.test(id));
	return ids.flatMap((id): InProgress[] => {
		const start = state.evidence.started[id];
		const open = state.subagents.lanes[id];
		const closed = latestLaneClose(state.marked, id);
		const lane = open ?? (closed !== undefined && closed.index > choice && closed.data.outcome === "parked" ? closed.data : undefined);
		if (lane !== undefined) return [{ unit: id, lane, open: open !== undefined, pre: start?.pre.sha ?? lane.base, ...(existsSync(lane.path) ? { root: lane.path } : {}) }];
		return start === undefined ? [] : [{ unit: id, open: false, root: cwd, pre: start.pre.sha }];
	});
}

// --- wip branches --------------------------------------------------------------------

const wipMessage = (unit: string, prereq: number[]): string => `wip(${unit}): parked for ${prereq.map((n) => `#${n}`).join(", ")}`;

/** Pushes HEAD of `root` to the wip branch; the refspec is built from the Branch line and the unit id only. */
async function push(p: Park, root: string, unit: string): Promise<void> {
	const wip = wipBranch(p.branch, unit);
	try {
		await guardedPush(p.w.session.exec, root, REMOTE, `HEAD:refs/heads/${wip}`);
	} catch (error) {
		if (!(error instanceof GitError)) throw error;
		throw new ParkRefusal(`pushing ${wip} failed (${untrusted(messageOf(error))}); the branches pushed so far are kept. Fix the cause and rerun change_park.`);
	}
}

/** Commits everything on the wip branch the worktree is on, unless its last commit already is the wip commit. */
async function commitWip(git: Git, u: InProgress, prereq: number[]): Promise<string> {
	const message = wipMessage(u.unit, prereq);
	const dirty = await git.isDirty();
	if (!dirty && (await git.subjects(u.pre, "HEAD")).at(-1) === message) return git.head();
	if (dirty) await git.addAll();
	return git.commit(message, { allowEmpty: !dirty });
}

/**
 * Whether the unit's local wip branch is to be reused: it exists and is not merged into the change branch (a
 * rerun of this park). A merged one is left by a resume and is deleted, so the unit parks from its current HEAD.
 */
async function reusableWip(p: Park, wip: string): Promise<boolean> {
	if (!(await p.git.branchExists(wip))) return false;
	if (!(await p.git.isAncestor(wip, p.branch))) return true;
	await p.git.deleteBranch(wip);
	return false;
}

/** Whether `rev` has commits since the unit's pre SHA. */
async function hasCommits(git: Git, pre: string, rev: string): Promise<boolean> {
	return (await git.revList(`${pre}..${rev}`)).length > 0;
}

/**
 * Checks out the existing wip branch in the worktree of `git` at `root` (a lane worktree, or the clean change
 * worktree), pushes it and returns its head; the change worktree returns to the change branch.
 */
async function pushWip(p: Park, git: Git, root: string, unit: string): Promise<string> {
	const wip = wipBranch(p.branch, unit);
	if ((await git.branch()) !== wip) await git.switchTo(wip);
	try {
		await push(p, root, unit);
		return await git.head();
	} finally {
		if (root === p.w.session.cwd) await git.switchTo(p.branch);
	}
}

/** The unit's worktree: branch it (or reuse its wip branch), commit and push. The change worktree returns to the change branch. */
async function branchInWorktree(p: Park, u: InProgress, root: string): Promise<ParkedUnit> {
	const wip = wipBranch(p.branch, u.unit);
	const lane = u.lane !== undefined;
	const git = root === p.w.session.cwd ? p.git : createGit(root, p.w.session.exec);
	const on = await git.branch();
	if (on !== wip && (await reusableWip(p, wip))) {
		if (await git.isDirty()) throw new ParkRefusal(`${wip} exists, but ${untrusted(root)} has uncommitted changes outside it; commit or move them, then rerun change_park.`);
		return { unit: u.unit, branch: wip, head: await pushWip(p, git, root, u.unit), lane };
	}
	if (on !== wip) {
		if (!(await git.isDirty()) && !(await hasCommits(git, u.pre, "HEAD"))) return { unit: u.unit, lane };
		await git.switchCreate(wip, "HEAD");
	}
	try {
		const head = await commitWip(git, u, p.prereq);
		await push(p, root, u.unit);
		return { unit: u.unit, branch: wip, head, lane };
	} finally {
		if (!lane) await git.switchTo(p.branch);
	}
}

/**
 * A lane whose worktree is gone: an existing wip branch is re-pushed; otherwise a lane branch with commits since
 * the pre SHA becomes the wip branch, so its commits are never lost. Both are pushed from the change worktree.
 */
async function branchGoneLane(p: Park, u: InProgress, lane: LaneRecord): Promise<ParkedUnit> {
	const wip = wipBranch(p.branch, u.unit);
	const cwd = p.w.session.cwd;
	if (await reusableWip(p, wip)) return { unit: u.unit, branch: wip, head: await pushWip(p, p.git, cwd, u.unit), lane: true };
	if (!(await p.git.branchExists(lane.branch)) || !(await hasCommits(p.git, u.pre, lane.branch))) return { unit: u.unit, lane: true };
	await p.git.switchCreate(wip, lane.branch);
	return { unit: u.unit, branch: wip, head: await pushWip(p, p.git, cwd, u.unit), lane: true };
}

/** One unit's park entry: no branch for a unit with no work. */
async function parkUnit(p: Park, u: InProgress): Promise<ParkedUnit> {
	if (u.root !== undefined) return branchInWorktree(p, u, u.root);
	return branchGoneLane(p, u, u.lane as LaneRecord);
}

// --- the park ----------------------------------------------------------------------

/** Change-worktree units first, so its tree is clean before any wip branch is pushed from it; the record keeps unit order. */
async function parkUnits(p: Park, units: InProgress[]): Promise<ParkedUnit[]> {
	const cwd = p.w.session.cwd;
	const order = [...units.filter((u) => u.root === cwd), ...units.filter((u) => u.root !== cwd)];
	const parked = new Map<string, ParkedUnit>();
	for (const u of order) parked.set(u.unit, await parkUnit(p, u));
	return units.map((u) => parked.get(u.unit) as ParkedUnit);
}

/** Whether deleting the local lane branch loses nothing: it has no commits since pre, or the pushed wip head holds it. */
async function laneBranchSafe(p: Park, u: InProgress, lane: LaneRecord, entry: ParkedUnit | undefined): Promise<boolean> {
	if (!(await hasCommits(p.git, u.pre, lane.branch))) return true;
	return entry?.head !== undefined && (await p.git.isAncestor(lane.branch, entry.head));
}

/**
 * Closes each parked lane: the closed `parked` record when it is still open, then the worktree removal and the
 * local lane branch deletion, also for a leftover of a closed lane. A lane branch holding commits the pushed
 * wip branch lacks is kept and returned.
 */
async function closeLanes(p: Park, units: InProgress[], parked: ParkedUnit[]): Promise<string[]> {
	const n = p.state.issue.number;
	const kept: string[] = [];
	for (const u of units) {
		const lane = u.lane;
		if (lane === undefined) continue;
		if (u.open) await p.w.forge.createComment(n, laneComment({ ...lane, closed: true, outcome: "parked" }));
		if (existsSync(lane.path)) await p.git.worktreeRemove(lane.path);
		await p.git.worktreePrune();
		if (!(await p.git.branchExists(lane.branch))) continue;
		if (await laneBranchSafe(p, u, lane, parked.find((e) => e.unit === u.unit))) await p.git.deleteBranch(lane.branch);
		else kept.push(lane.branch);
	}
	return kept;
}

async function park(p: Park): Promise<ToolResult<ChangeParkDetails>> {
	const n = p.state.issue.number;
	// Drops registrations of lane worktrees whose directory is gone, so git no longer sees their branches as checked out.
	await p.git.worktreePrune();
	const units = inProgress(p.state, p.w.session.cwd);
	if ((await p.git.isDirty()) && !units.some((u) => u.root === p.w.session.cwd)) return refuse("the change worktree has uncommitted changes and no unit is started in it; commit or stash them, then rerun.");
	let parked: ParkedUnit[];
	try {
		parked = await parkUnits(p, units);
	} catch (error) {
		if (error instanceof ParkRefusal) return refuse(error.message);
		throw error;
	}
	const kept = await closeLanes(p, units, parked);
	await p.w.forge.addLabels(n, [LABEL_PARKED]);
	await p.w.forge.createComment(n, parkedComment({ waits_for: p.prereq, units: parked, at: new Date().toISOString() }));
	await afterForgeWrite(p.w.session, n);
	const waits = p.prereq.map((d) => `#${d}`).join(", ");
	const branches = parked.flatMap((u) => (u.branch === undefined ? [] : [u.branch]));
	const keptText = kept.length === 0 ? "" : ` Kept the local lane branches ${kept.join(", ")}: they hold commits no wip branch has.`;
	const text = `Parked #${n} waiting for ${waits}; ${branches.length === 0 ? "no unit had work to keep" : `wip branches pushed: ${branches.join(", ")}`}.${keptText}`;
	return toolResult(withStep(p.w.session, text), { units: parked });
}

export async function runChangePark(ctx: ToolCtx): Promise<ToolResult<ChangeParkDetails>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return { ...child, details: {} };
	return withEvidenceLock(async () => {
		const w = await prepareWrite();
		if (!w.ok) return refuse(w.message);
		const change = requireChange(w.session);
		if (!change.ok) return refuse(change.message);
		const { state } = change;
		const refused = stateRefusal(state);
		if (refused !== undefined) return refuse(refused);
		const prereq = await waitedFor(w, state);
		if ("refused" in prereq) return refuse(prereq.refused);
		if (prereq.length === 0) return refuse("every dependency of the change is merged: the prerequisite is not in Depends yet or already merged, so there is nothing to wait for. Nothing was written.");
		return park({ w, state, branch: state.change.header.branch as string, git: w.session.git, prereq });
	});
}

export function registerChangePark(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Park a livespec change",
		description:
			"After the new-dependency gate chose A: push each in-progress unit's work to <Branch>--wip-<unit>, close open lanes as parked, add the livespec:parked label and record what the change waits for. Parent session only; takes no parameters.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No parameters: the refspec comes from the issue.
		parameters: { type: "object", properties: {} } as never,
		execute: (_id, _params, _signal, _update, ctx) => runChangePark(ctx as ToolCtx),
	});
}
