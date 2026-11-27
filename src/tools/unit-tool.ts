// What `unit_start` and `unit_finish` share: the evidence lock around refresh,
// change resolution, the refusal rules and the run environment; and the texts
// of a blocked, invalid or aborted `Verify` run.

import { existsSync } from "node:fs";
import type { Unit } from "../core/change.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { createGit, type Git } from "../engine/git.ts";
import { withEvidenceLock } from "../evidence/lock.ts";
import type { RunClass } from "../evidence/red-green.ts";
import type { VerifyRun } from "../evidence/runner.ts";
import { type RunWorktree, type VerifyEnv, verifyEnv } from "../evidence/verify-env.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { displayUnitId } from "../interaction/display-ids.ts";
import { unitRoot } from "../subagents/state.ts";
import type { Session } from "../hooks/session.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { withStep } from "./request-flow.ts";

/** The only parameter of both tools: no outcome, verdict, pending flag, attempt count or exit code. */
export const UNIT_PARAMETERS = { type: "object", properties: { unit: { type: "string" } }, required: ["unit"] };

const ABORTED = "Verify was aborted (the tool call was cancelled or the session is shutting down); nothing was recorded.";

/** Where the unit runs, and a hook that runs under the lock before the change is resolved. */
export type LockedCallOptions = { where?: "unit" | "change"; before?: (w: WriteContext) => Promise<void> };

/** One locked call: the fresh write context, the change state, the unit and the run environment. */
export type UnitCall = {
	w: WriteContext;
	state: ChangeState;
	pack: Pack;
	unit: Unit;
	env: VerifyEnv;
	refuse(message: string): ToolResult<undefined>;
	/** The refusal to return when the call was cancelled; checked after each async step and before each write. */
	cancelled(): ToolResult<undefined> | undefined;
	/** A successful result, followed by the card's next step. */
	done(text: string): ToolResult<undefined>;
};

/** The refusal of the D10 rules, or the go-ahead. */
export type Precheck = { refused: string } | { ok: true };

/** The refusal rules may be async: the finish gate reads git. `git` is the unit's worktree git. */
export type PrecheckFn = (state: ChangeState, pack: Pack, git: Git) => Precheck | Promise<Precheck>;

export const startable = (refusal: string | undefined): Precheck => (refusal === undefined ? { ok: true } : { refused: refusal });

/** The unit's worktree: its open lane, else the change worktree. The state's HEAD and dirty flag are read there. */
async function unitWorktree(session: Session, state: ChangeState, unit: string): Promise<{ state: ChangeState; at: RunWorktree | undefined } | { refused: string }> {
	const root = unitRoot(state, unit, session.cwd);
	if (root === session.cwd) return { state, at: undefined };
	if (!existsSync(root)) return { refused: `the lane worktree of ${displayUnitId(unit)} is gone (${root}); run lane_merge ${displayUnitId(unit)} to close the lane, then ${displayUnitId(unit)} re-runs in the change worktree.` };
	const git = createGit(root);
	const [head, dirty] = await Promise.all([git.head(), git.isDirty()]);
	return { state: { ...state, git: { ...state.git, head, dirty } }, at: { root, git } };
}

/**
 * Runs `body` for `unit` under the evidence lock, after `prepareWrite` (which refreshes), `requireChange`,
 * the `precheck` rules and a run environment whose signal is not aborted yet. Every refusal writes nothing.
 * `where: "change"` keeps the change worktree even when the unit has an open lane (`lane_merge`).
 * `before` runs right after `prepareWrite`, under the lock; `requireChange` then reads the session it may refresh.
 */
export function lockedEvidenceCall(
	tool: string,
	unit: string,
	signal: AbortSignal | undefined,
	precheck: PrecheckFn,
	body: (c: UnitCall) => Promise<ToolResult<undefined>>,
	opts: LockedCallOptions = {},
): Promise<ToolResult<undefined>> {
	const { where = "unit", before } = opts;
	const refuse = (message: string): ToolResult<undefined> => toolResult(message.startsWith(`${tool} refused`) ? message : `${tool} refused: ${message}`, undefined, true);
	return withEvidenceLock(async () => {
		const w = await prepareWrite();
		if (!w.ok) return refuse(w.message);
		await before?.(w);
		const change = requireChange(w.session);
		if (!change.ok) return refuse(change.message);
		const lane = where === "change" ? { state: change.state, at: undefined } : await unitWorktree(w.session, change.state, unit);
		if ("refused" in lane) return refuse(lane.refused);
		const { state } = lane;
		const check = await precheck(state, w.pack, lane.at?.git ?? w.session.git);
		if ("refused" in check) return refuse(check.refused);
		const target = state.change.units.find((u) => u.id === unit);
		if (target === undefined) return refuse(`${displayUnitId(unit)} is not a unit of this change.`);
		const env = await verifyEnv(w.session, signal, lane.at);
		const cancelled = (): ToolResult<undefined> | undefined => (env.run.signal?.aborted ? refuse(ABORTED) : undefined);
		const stop = cancelled();
		if (stop !== undefined) return stop;
		const done = (text: string): ToolResult<undefined> => toolResult(withStep(w.session, text), undefined);
		return body({ w, state, pack: w.pack, unit: target, env, refuse, cancelled, done });
	});
}

/** The guard blocked `Verify`: it was never spawned. */
export function verifyBlocked(unit: string, reason: string): string {
	return `the Verify command of ${displayUnitId(unit)} is blocked, so it was not run: ${untrusted(reason)} Fix Verify with unit_amend.`;
}

/** The captured output, as untrusted data. */
export function unitResult(output: string): string {
	return output === "" ? "Output: (none)" : `Output:\n${untrusted(output)}`;
}

/** Why an invalid run is not a usable result. */
export function invalidText(cls: Exclude<RunClass, "red" | "green">, run: Pick<VerifyRun, "exit" | "spawnError">): string {
	switch (cls.invalid) {
		case "aborted":
			return ABORTED;
		case "timeout":
			return "Verify timed out, and its process group was killed.";
		case "spawn":
			return `Verify could not run: the shell failed to start (${untrusted(run.spawnError ?? "")}).`;
		case "setup":
			return "Verify could not run: verify.setup failed in the temporary worktree.";
		case "not-runnable":
			return `Verify could not run (exit ${run.exit ?? "none"}): the command was not found or is not executable; fix Verify with unit_amend.`;
	}
}

/** The refusal of a run that is neither red nor green. */
export function refusedRun(tool: string, cls: Exclude<RunClass, "red" | "green">, run: VerifyRun): string {
	return `${tool} refused: ${invalidText(cls, run)}\n${unitResult(run.output)}`;
}
