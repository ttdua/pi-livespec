// Lane side effects through the engine's git: create or reuse the worktree, check `Files`, merge, verify, undo, and post the records.

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createGit, type Git } from "../engine/git.ts";
import { defaultGitExec } from "../engine/git-exec.ts";
import { type FindingSummaryData, findingSummaryComment } from "./records.ts";
import { LANES_DIR, laneBranch, lanePath } from "./lanes.ts";
import { type LaneOutcome, type LaneRecord, laneComment } from "./state.ts";

/** Git of the change worktree, its root, and a poster for own comments on the change issue. */
export type LaneOps = { git: Git; root: string; post(body: string): Promise<void> };

/** `aborted`: the `Verify` run was cancelled, so the merge is undone and the lane stays open. */
export type MergeOutcome = "merged" | "violation" | "conflict" | "red" | "aborted";

/** What `mergeLane` needs beyond the lane: the unit's `Files`, the next review round, and `Verify` on the change root after the merge. */
export type MergeChecks = { files: string[]; round: number; verify(): Promise<"green" | "red" | "aborted"> };

const EXCLUDE_LINE = `/${LANES_DIR}/`;

/** Adds `/.worktrees/` to `<git common dir>/info/exclude` once, so lanes never dirty the change worktree. */
export async function excludeLanes(root: string): Promise<void> {
	const result = await defaultGitExec(["rev-parse", "--git-common-dir"], { cwd: root });
	if (result.code !== 0) throw new Error(`cannot find the git common dir: ${result.stderr.trim() || result.spawnError || "git failed"}`);
	const common = result.stdout.trim();
	const file = join(isAbsolute(common) ? common : resolve(root, common), "info", "exclude");
	const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});
	if (text.split("\n").some((l) => l.trim() === EXCLUDE_LINE)) return;
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${EXCLUDE_LINE}\n`);
}

/** A leftover worktree at the lane path is reused only when it is clean at the change HEAD. */
async function leftoverRefusal(path: string, head: string): Promise<string | undefined> {
	const git = createGit(path);
	const [at, dirty] = await Promise.all([git.head().catch(() => ""), git.isDirty().catch(() => true)]);
	if (at === head && !dirty) return undefined;
	return `a leftover worktree exists at ${path} ${at === head ? "with uncommitted changes" : "at a commit other than the change branch HEAD"}; remove it, then run lane_open again.`;
}

/** Creates the lane worktree on its branch, or reuses a clean leftover at HEAD; a leftover branch elsewhere is refused. */
async function prepareWorktree(ops: LaneOps, path: string, branch: string, head: string): Promise<string | undefined> {
	if (existsSync(path)) return leftoverRefusal(path, head);
	if (await ops.git.branchExists(branch)) {
		if ((await ops.git.revParse(branch)) !== head) return `the branch ${branch} exists at a commit other than the change branch HEAD; delete it, then run lane_open again.`;
		await ops.git.deleteBranch(branch);
	}
	await ops.git.worktreeAddBranch(path, branch, head);
	return undefined;
}

/** Opens the lane of `unit` from the change branch HEAD and posts its open `lane` record. */
export async function openLane(ops: LaneOps, change: string, unit: string): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
	const path = lanePath(ops.root, change, unit);
	const branch = laneBranch(change, unit);
	const head = await ops.git.head();
	await excludeLanes(ops.root);
	const refused = await prepareWorktree(ops, path, branch, head);
	if (refused !== undefined) return { ok: false, message: refused };
	await ops.post(laneComment({ unit, path, branch, base: head }));
	return { ok: true, path };
}

/** Files the lane's commits changed that are not in the unit's `Files`. */
export async function filesViolation(git: Git, lane: LaneRecord, files: string[]): Promise<string[]> {
	const changed = await git.diffNames(lane.base, lane.branch, ".");
	return changed.filter((f) => !files.includes(f));
}

/** Posts the closed `lane` record, then removes the worktree and its branch. */
export async function closeLane(ops: LaneOps, lane: LaneRecord, how: { outcome: LaneOutcome; head?: string }): Promise<void> {
	await ops.post(laneComment({ ...lane, closed: true, ...how }));
	if (existsSync(lane.path)) await ops.git.worktreeRemove(lane.path);
	await ops.git.worktreePrune();
	if (await ops.git.branchExists(lane.branch)) await ops.git.deleteBranch(lane.branch);
}

/** An advisory, not-completed summary: it records the violation for the next plan review without blocking or counting as a review. */
function violationSummary(lane: LaneRecord, paths: string[], round: number, head: string): FindingSummaryData {
	return {
		role: "reviewer", subject: "unit", unit: lane.unit, round, status: "DONE_WITH_CONCERNS", advisory: true, head, packet: "", sources_used: [], required: [],
		completed: false, agentSource: "livespec", requested: { thinking: "low" }, effective: {},
		findings: paths.map((path) => ({
			severity: "WARNING", kind: "files-violation", location: `${path}:1`, evidence: `the lane of ${lane.unit} changed ${path}, which is not in its Files`,
			fix: `add ${path} to the Files of ${lane.unit} with unit_amend, or move the change to the unit that owns it`, scope: "out-of-scope",
		})),
	};
}

/**
 * Merges the lane into the change branch: a `Files` violation merges nothing; a conflict is aborted; a red
 * `Verify` after the merge is undone with `resetHard`. Every outcome closes and removes the lane.
 */
export async function mergeLane(ops: LaneOps, lane: LaneRecord, checks: MergeChecks): Promise<MergeOutcome> {
	const head = await ops.git.revParse(lane.branch);
	const outside = await filesViolation(ops.git, lane, checks.files);
	if (outside.length > 0) {
		await ops.post(findingSummaryComment(violationSummary(lane, outside, checks.round, head)));
		await closeLane(ops, lane, { outcome: "violation" });
		return "violation";
	}
	const pre = await ops.git.head();
	if ((await ops.git.merge(lane.branch)) === "conflict") {
		await ops.git.mergeAbort();
		await closeLane(ops, lane, { outcome: "conflict" });
		return "conflict";
	}
	const verdict = await checks.verify();
	if (verdict !== "green") await ops.git.resetHard(pre);
	if (verdict === "aborted") return "aborted";
	if (verdict === "red") {
		await closeLane(ops, lane, { outcome: "red" });
		return "red";
	}
	await closeLane(ops, lane, { outcome: "merged", head });
	return "merged";
}
