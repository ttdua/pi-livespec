// `change_park` (design D13, spec discovered-dependencies "Park tool"): after the new-dependency gate chose A,
// every in-progress unit with work gets a wip branch `<Branch>--wip-<unit>` in its worktree, committed and
// pushed through `guardedPush` (the refspec comes from the issue's Branch line and the unit id only). Then the
// open lanes close as `parked`, the label is added and the `parked` record is posted last, so a crash before it
// leaves the change unparked and a rerun completes the park: an existing wip branch is reused and re-pushed.

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
import { closeLane, type LaneOps } from "../subagents/lane-ops.ts";
import { type LaneRecord, latestLaneClose } from "../subagents/state.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

export type ChangeParkDetails = { units?: ParkedUnit[] };

const TOOL = "change_park";
const REMOTE = "origin";
const PARKED_KIND = "parked";

/** An in-progress unit: where its work lives (`root` undefined when its lane worktree is gone) and its pre SHA. */
type InProgress = { unit: string; lane?: LaneRecord; root?: string; pre: string };

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
 * Open lanes, lanes this park already closed (a crash before the record), and units started in the change
 * worktree, in unit order.
 */
function inProgress(state: ChangeState, cwd: string): InProgress[] {
	const choice = latestDependencyChoice(state.marked)?.index ?? -1;
	return state.change.units.flatMap((u): InProgress[] => {
		const start = state.evidence.started[u.id];
		const lane = state.subagents.lanes[u.id];
		if (lane !== undefined) return [{ unit: u.id, lane, pre: start?.pre.sha ?? lane.base, ...(existsSync(lane.path) ? { root: lane.path } : {}) }];
		const closed = latestLaneClose(state.marked, u.id);
		if (closed !== undefined && closed.index > choice && closed.data.outcome === "parked") return [{ unit: u.id, lane: closed.data, pre: closed.data.base }];
		return start === undefined ? [] : [{ unit: u.id, root: cwd, pre: start.pre.sha }];
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

/** Whether the unit has commits since its pre SHA or uncommitted work. */
async function hasWork(git: Git, pre: string): Promise<boolean> {
	return (await git.isDirty()) || (await git.revList(`${pre}..HEAD`)).length > 0;
}

/** Pushes an existing local wip branch from the change worktree, which is clean, then switches back. */
async function pushFromChange(p: Park, unit: string): Promise<string> {
	const wip = wipBranch(p.branch, unit);
	await p.git.switchTo(wip);
	try {
		await push(p, p.w.session.cwd, unit);
		return await p.git.head();
	} finally {
		await p.git.switchTo(p.branch);
	}
}

/** The unit's worktree: branch it (or reuse its wip branch), commit and push. The change worktree returns to the change branch. */
async function branchInWorktree(p: Park, u: InProgress, root: string): Promise<ParkedUnit> {
	const wip = wipBranch(p.branch, u.unit);
	const lane = u.lane !== undefined;
	const git = root === p.w.session.cwd ? p.git : createGit(root, p.w.session.exec);
	const on = await git.branch();
	if (on !== wip && (await p.git.branchExists(wip))) {
		if (await git.isDirty()) throw new ParkRefusal(`${wip} exists, but ${untrusted(root)} has uncommitted changes outside it; commit or move them, then rerun change_park.`);
		return { unit: u.unit, branch: wip, head: lane ? await pushReused(p, git, root, u.unit) : await pushFromChange(p, u.unit), lane };
	}
	if (on !== wip) {
		if (!(await hasWork(git, u.pre))) return { unit: u.unit, lane };
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

/** A lane worktree on another branch while its wip branch exists: push the wip branch from the lane worktree. */
async function pushReused(p: Park, git: Git, root: string, unit: string): Promise<string> {
	await git.switchTo(wipBranch(p.branch, unit));
	await push(p, root, unit);
	return git.head();
}

/** One unit's park entry: no branch for a gone worktree without a local wip branch, or for a unit with no work. */
async function parkUnit(p: Park, u: InProgress): Promise<ParkedUnit> {
	const lane = u.lane !== undefined;
	if (u.root !== undefined) return branchInWorktree(p, u, u.root);
	if (!(await p.git.branchExists(wipBranch(p.branch, u.unit)))) return { unit: u.unit, lane };
	return { unit: u.unit, branch: wipBranch(p.branch, u.unit), head: await pushFromChange(p, u.unit), lane };
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

async function closeLanes(p: Park): Promise<void> {
	const n = p.state.issue.number;
	const ops: LaneOps = { git: p.git, root: p.w.session.cwd, post: async (body) => void (await p.w.forge.createComment(n, body)) };
	for (const lane of Object.values(p.state.subagents.lanes)) await closeLane(ops, lane, { outcome: "parked" });
}

async function park(p: Park): Promise<ToolResult<ChangeParkDetails>> {
	const n = p.state.issue.number;
	const units = inProgress(p.state, p.w.session.cwd);
	if ((await p.git.isDirty()) && !units.some((u) => u.root === p.w.session.cwd)) return refuse("the change worktree has uncommitted changes and no unit is started in it; commit or stash them, then rerun.");
	let parked: ParkedUnit[];
	try {
		parked = await parkUnits(p, units);
	} catch (error) {
		if (error instanceof ParkRefusal) return refuse(error.message);
		throw error;
	}
	await closeLanes(p);
	await p.w.forge.addLabels(n, [LABEL_PARKED]);
	await p.w.forge.createComment(n, parkedComment({ waits_for: p.prereq, units: parked, at: new Date().toISOString() }));
	await afterForgeWrite(p.w.session, n);
	const waits = p.prereq.length === 0 ? "nothing" : p.prereq.map((d) => `#${d}`).join(", ");
	const branches = parked.flatMap((u) => (u.branch === undefined ? [] : [u.branch]));
	const text = `Parked #${n} waiting for ${waits}; ${branches.length === 0 ? "no unit had work to keep" : `wip branches pushed: ${branches.join(", ")}`}.`;
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
