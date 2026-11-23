// `unit_start { unit }` (design D10): under the evidence lock, refuses in D10
// order, checks `Verify` with the guard, decides verifier pending, runs `Verify`
// at HEAD for a unit that is not pending, and posts the `unit-start` record.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Unit } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import { lockedEvidenceCall, refusedRun, startable, type UnitCall, unitResult, UNIT_PARAMETERS, verifyBlocked } from "./unit-tool.ts";
import { pendingDecision } from "../evidence/pending.ts";
import { isResumedUnit } from "../deps/parked.ts";
import { newEvidenceId, type StartData, startComment, type StartVerdict } from "../evidence/records.ts";
import { classifyRun, preExpectation } from "../evidence/red-green.ts";
import { refactorPendingRefusal, unitStartRefusal } from "../evidence/refusals.ts";
import { runVerify } from "../evidence/runner.ts";
import { RECEIPT_OUTPUT_BYTES, type VerifyEnv } from "../evidence/verify-env.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { afterForgeWrite, type ToolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";

const TOOL = "unit_start";
const WRONG_CLASS_OPTIONS =
	"Options: keep the test as a regression pin or drop the unit through unit_amend, or fix Verify so it fails before the work (unit_amend).";

/** The verdict a green run at pre records instead of a refusal: a review-routed rebuild, or a unit of a resumed park. */
function greenVerdict(state: ChangeState, unit: string): Extract<StartVerdict, "rebuild" | "resumed"> | undefined {
	if (unit in (state.evidence.rebuilds ?? {})) return "rebuild";
	return isResumedUnit(state.marked, unit) ? "resumed" : undefined;
}

/** Whether some test file in `Files` is missing at HEAD. */
async function isPending(env: VerifyEnv, u: Unit, head: string): Promise<boolean> {
	const present = new Map<string, boolean>();
	for (const path of u.files) present.set(path, await env.git.pathExistsAt(head, path));
	return pendingDecision(u, (path) => present.get(path) === true);
}

/** Runs `Verify` at HEAD and builds the start data, or the refusal of a wrong class. */
async function preRun(env: VerifyEnv, u: Unit, verify: string, head: string, green: ReturnType<typeof greenVerdict>): Promise<StartData | { refused: string }> {
	const run = await runVerify(verify, { ...env.run, cwd: env.root, tailBytes: RECEIPT_OUTPUT_BYTES });
	if ("blocked" in run) return { refused: verifyBlocked(u.id, run.blocked) };
	const cls = classifyRun(run);
	if (typeof cls === "object") return { refused: refusedRun(TOOL, cls, run) };
	const expected = preExpectation(u);
	// A rebuild or a resumed unit starts from its green state; a red Verify keeps the usual red verdict.
	const verdict: StartVerdict = green !== undefined && cls === "green" ? green : cls;
	if (verdict === cls && cls !== expected) {
		return { refused: `${TOOL} refused: Verify was ${cls} (exit ${run.exit}) at HEAD, but ${u.id} must be ${expected} before the work. ${WRONG_CLASS_OPTIONS}\n${unitResult(run.output)}` };
	}
	const data: StartData = { unit: u.id, digest: unitDigest(u), verify, pre: { sha: head, exit: run.exit as number, verdict, output: run.output } };
	if (u.kind === "refactor") data.refactor = true;
	return data;
}

async function startUnit(c: UnitCall): Promise<ToolResult<undefined>> {
	const { w, state, env } = c;
	const u = c.unit;
	const verify = u.verify ?? "";
	const blocked = env.run.guard(verify);
	if (blocked !== undefined) return c.refuse(verifyBlocked(u.id, blocked));
	const head = state.git.head;
	const pending = await isPending(env, u, head);
	const afterPending = c.cancelled();
	if (afterPending !== undefined) return afterPending;
	const refactor = refactorPendingRefusal(u, pending);
	if (refactor !== undefined) return c.refuse(refactor);
	const data = pending ? ({ unit: u.id, digest: unitDigest(u), verify, pre: { sha: head }, pending: true } as StartData) : await preRun(env, u, verify, head, greenVerdict(state, u.id));
	if ("refused" in data) return c.refuse(data.refused);
	const beforeWrite = c.cancelled();
	if (beforeWrite !== undefined) return beforeWrite;
	await w.forge.createComment(state.issue.number, startComment(newEvidenceId(u.id, new Date()), data));
	await afterForgeWrite(w.session, state.issue.number);
	const how = pending ? "verifier pending: commit the failing test alone first; unit_finish checks it" : `Verify was ${data.pre.verdict === "rebuild" || data.pre.verdict === "resumed" ? `green, ${data.pre.verdict}` : data.pre.verdict} (exit ${data.pre.exit})`;
	return c.done(`Started ${u.id} at ${head.slice(0, 7)}; ${how}.${pending ? "" : `\n${unitResult(data.pre.output ?? "")}`}`);
}

export function runUnitStart(unit: string, signal?: AbortSignal): Promise<ToolResult<undefined>> {
	return lockedEvidenceCall(TOOL, unit, signal, (state, pack) => startable(unitStartRefusal(state, pack, unit)), startUnit);
}

export function registerUnitStart(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Start a livespec unit",
		description:
			"Start one unit of the build phase: livespec runs its Verify at HEAD, which must fail (pass for a refactor unit), and records the start. A unit whose test file does not exist yet is started as verifier pending without running Verify. Takes only the unit id.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No outcome, verdict, pending or exit parameter.
		parameters: UNIT_PARAMETERS as never,
		execute: (_id, params, signal) => runUnitStart((params as { unit: string }).unit, signal),
	});
}
