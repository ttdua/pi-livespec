// What `unit_start` and `unit_finish` share: the evidence lock around refresh,
// change resolution, the refusal rules and the run environment; and the texts
// of a blocked, invalid or aborted `Verify` run.

import type { Unit } from "../core/change.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { withEvidenceLock } from "../evidence/lock.ts";
import type { RunClass } from "../evidence/red-green.ts";
import type { VerifyRun } from "../evidence/runner.ts";
import { type VerifyEnv, verifyEnv } from "../evidence/verify-env.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { displayUnitId } from "../interaction/display-ids.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { withStep } from "./request-flow.ts";

/** The only parameter of both tools: no outcome, verdict, pending flag, attempt count or exit code. */
export const UNIT_PARAMETERS = { type: "object", properties: { unit: { type: "string" } }, required: ["unit"] };

const ABORTED = "Verify was aborted (the tool call was cancelled or the session is shutting down); nothing was recorded.";

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

export const startable = (refusal: string | undefined): Precheck => (refusal === undefined ? { ok: true } : { refused: refusal });

/**
 * Runs `body` for `unit` under the evidence lock, after `prepareWrite` (which refreshes), `requireChange`,
 * the `precheck` rules and a run environment whose signal is not aborted yet. Every refusal writes nothing.
 */
export function lockedEvidenceCall(
	tool: string,
	unit: string,
	signal: AbortSignal | undefined,
	precheck: (state: ChangeState, pack: Pack) => Precheck,
	body: (c: UnitCall) => Promise<ToolResult<undefined>>,
): Promise<ToolResult<undefined>> {
	const refuse = (message: string): ToolResult<undefined> => toolResult(message.startsWith(`${tool} refused`) ? message : `${tool} refused: ${message}`, undefined, true);
	return withEvidenceLock(async () => {
		const w = await prepareWrite();
		if (!w.ok) return refuse(w.message);
		const change = requireChange(w.session);
		if (!change.ok) return refuse(change.message);
		const { state } = change;
		const check = precheck(state, w.pack);
		if ("refused" in check) return refuse(check.refused);
		const target = state.change.units.find((u) => u.id === unit);
		if (target === undefined) return refuse(`${displayUnitId(unit)} is not a unit of this change.`);
		const env = await verifyEnv(w.session, signal);
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
