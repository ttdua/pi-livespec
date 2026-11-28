// `lane_merge { unit }`: merges a reviewed lane into the change branch, runs `Verify` there, and closes the lane; a violation, conflict or red run re-runs the unit sequentially.

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGit } from "../engine/git.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { StartRecord } from "../evidence/records.ts";
import { classifyRun, postOk } from "../evidence/red-green.ts";
import { runVerify, type VerifyRun } from "../evidence/runner.ts";
import { RECEIPT_OUTPUT_BYTES } from "../evidence/verify-env.ts";
import { unitInvariantRefusal } from "../evidence/refusals.ts";
import { buildLoopStep } from "../subagents/build-loop.ts";
import { closeLane, type LaneOps, laneDirty, mergeLane, type MergeOutcome } from "../subagents/lane-ops.ts";
import { nextRound } from "../subagents/run-record.ts";
import type { LaneRecord } from "../subagents/state.ts";
import { afterForgeWrite, type ToolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { appendRecord } from "./subagent-request.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";
import { failed } from "./unit-finish.ts";
import { lockedEvidenceCall, type Precheck, refusedRun, type UnitCall, unitResult, UNIT_PARAMETERS, verifyBlocked } from "./unit-tool.ts";

const TOOL = "lane_merge";
const SEQUENTIAL = (unit: string): string => `The lane of ${unit} is closed and removed; ${unit} re-runs sequentially in the change worktree (see the next step).`;

/** The build-loop step of `unit` with HEAD at its lane head; undefined when the lane's work and review are done. */
async function laneStep(state: ChangeState, pack: Pack, unit: string, lane: LaneRecord): Promise<string | undefined> {
	const phase = pack.phases.find((p) => state.phase.kind === "ok" && p.id === state.phase.id);
	if (phase === undefined) return "the change has no single phase.";
	const head = await createGit(lane.path).head();
	const atLane = { ...state, git: { ...state.git, head }, subagents: { ...state.subagents, laneHeads: { ...state.subagents.laneHeads, [unit]: head } } };
	const step = buildLoopStep(pack, atLane, phase, unit, { merging: true });
	return step?.next;
}

/** A started unit in the change worktree (e.g. a merged lane not finished yet): lanes merge one at a time. */
const unfinished = (state: ChangeState, unit: string): string | undefined =>
	Object.keys(state.evidence.started).find((id) => id !== unit && !(id in state.subagents.lanes));

/** No open lane (a lane whose worktree is gone always passes: `merge` closes it), a dirty change worktree or lane worktree, a unit that is frozen, stale, amended or blocked, another unfinished unit there, an unstarted unit, or a lane whose work or unit review is not done. */
function precheck(unit: string) {
	return async (state: ChangeState, pack: Pack): Promise<Precheck> => {
		const lane = state.subagents.lanes[unit];
		if (lane === undefined) return { refused: `${unit} has no open lane.` };
		if (!existsSync(lane.path)) return { ok: true };
		if (state.git.dirty) return { refused: "the change worktree has uncommitted changes; commit them first." };
		const other = unfinished(state, unit);
		if (other !== undefined) return { refused: `${other} is started in the change worktree: finish it with unit_finish ${other} first; lanes merge one at a time.` };
		if (!(unit in state.evidence.started)) return { refused: `${unit} is not started: run unit_start ${unit} in its lane first.` };
		const invalid = unitInvariantRefusal(state, pack, unit);
		if (invalid !== undefined) return { refused: invalid };
		if (existsSync(lane.path) && (await laneDirty(lane))) return { refused: `the lane worktree of ${unit} has uncommitted changes (${lane.path}); commit or discard them, then call lane_merge again.` };
		const pending = await laneStep(state, pack, unit, lane);
		return pending === undefined ? { ok: true } : { refused: `the lane of ${unit} is not ready to merge. Next: ${pending}` };
	};
}

type Verified = { run?: VerifyRun; mergeSha?: string };

/** The recovery for a lane whose worktree was deleted: its record closes as `moved` and the unit re-runs in the change worktree. */
async function closeGone(c: UnitCall, ops: LaneOps, lane: LaneRecord): Promise<ToolResult<undefined>> {
	await closeLane(ops, lane, { outcome: "moved" });
	await afterForgeWrite(c.w.session, c.state.issue.number);
	return c.done(`The lane worktree of ${c.unit.id} was gone (${lane.path}), so nothing was merged. ${SEQUENTIAL(c.unit.id)}`);
}

async function merge(c: UnitCall): Promise<ToolResult<undefined>> {
	const { w, state, env, unit: u } = c;
	const lane = state.subagents.lanes[u.id] as LaneRecord;
	const issue = state.issue.number;
	const ops: LaneOps = { git: env.git, root: env.root, post: (body) => w.forge.createComment(issue, body).then(() => undefined), record: (input) => appendRecord(w, issue, input) };
	if (!existsSync(lane.path)) return closeGone(c, ops, lane);
	const start = state.evidence.started[u.id] as StartRecord;
	const blocked = env.run.guard(start.verify);
	if (blocked !== undefined) return c.refuse(verifyBlocked(u.id, blocked));
	const seen: Verified = {};
	const verify = async (): Promise<"green" | "red" | "aborted"> => {
		seen.mergeSha = await env.git.head();
		const run = await runVerify(start.verify, { ...env.run, cwd: env.root, tailBytes: RECEIPT_OUTPUT_BYTES });
		if ("blocked" in run) return "aborted";
		seen.run = run;
		const cls = classifyRun(run);
		if (typeof cls === "object" && cls.invalid === "aborted") return "aborted";
		return postOk(cls) ? "green" : "red";
	};
	const outcome = await mergeLane(ops, lane, { files: u.files, round: nextRound(state.marked, "reviewer", u.id, "unit"), verify });
	await afterForgeWrite(w.session, issue);
	return report(c, outcome, start, seen);
}

async function report(c: UnitCall, outcome: MergeOutcome, start: StartRecord, seen: Verified): Promise<ToolResult<undefined>> {
	const u = c.unit.id;
	switch (outcome) {
		case "merged":
			return c.done(`Merged the lane of ${u} into the change branch at ${(seen.mergeSha ?? "").slice(0, 7)}; Verify passes there. Run unit_finish ${u}.\n${unitResult(seen.run?.output ?? "")}`);
		case "aborted":
			return c.refuse(`${seen.run === undefined ? "Verify was blocked by the guard." : refusedRun(TOOL, { invalid: "aborted" }, seen.run)}\nThe merge was undone; the lane stays open.`);
		case "violation":
			return { ...c.done(`The lane of ${u} changed files outside its Files, so nothing was merged; a files-violation finding is recorded for the next plan review or amendment. ${SEQUENTIAL(u)}`), isError: true };
		case "conflict":
			return { ...c.done(`Merging the lane of ${u} conflicted, so the merge was aborted. ${SEQUENTIAL(u)}`), isError: true };
		case "red": {
			const result = await failed(c, start, seen.run as VerifyRun, seen.mergeSha);
			return { ...result, content: [{ type: "text", text: `Verify failed on the change branch after merging the lane of ${u}; the merge was undone. ${SEQUENTIAL(u)}\n${result.content.map((x) => x.text).join("\n")}` }] };
		}
	}
}

export async function runLaneMerge(unit: string, ctx: ToolCtx, signal?: AbortSignal): Promise<ToolResult<undefined>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return child;
	return lockedEvidenceCall(TOOL, unit, signal, precheck(unit), merge, { where: "change" });
}

export function registerLaneMerge(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Merge a livespec lane",
		description:
			"Merge a unit's lane into the change branch once its unit review is done at the lane head: checks the lane only touched the unit's Files, merges with --no-ff, runs Verify on the change worktree, then closes and removes the lane. A violation, conflict or red Verify leaves the change branch as it was and re-runs the unit sequentially. Takes only the unit id.",
		parameters: UNIT_PARAMETERS as never,
		execute: (_id, params, signal, _update, ctx) => runLaneMerge((params as { unit: string }).unit, ctx as ToolCtx, signal),
	});
}
