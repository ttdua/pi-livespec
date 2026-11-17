// `unit_finish { unit }` (design D10): under the evidence lock, either reconciles
// a receipted, unticked unit with a tick, or checks a pending unit's test-only
// commit, runs `Verify` at HEAD, and records a receipt plus tick (green) or a
// `progress` decision record (red or invalid).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { unitDigest } from "../core/digest.ts";
import { parseChange } from "../core/change.ts";
import { TickError, tickUnit } from "../core/tick.ts";
import { decisionComment } from "../decide/records.ts";
import { decide } from "../decide/seam.ts";
import type { CachedForge } from "../forge/cache.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { liftsCap } from "../engine/iterations.ts";
import { isTestFile, testOnlyCommitCheck } from "../evidence/pending.ts";
import { previousSignature, progressRecord } from "../evidence/progress-rule.ts";
import { newEvidenceId, type ReceiptData, receiptComment, type StartRecord } from "../evidence/records.ts";
import { classifyRun, postOk } from "../evidence/red-green.ts";
import { blockedRefusal, finishMode, unitFinishRefusal } from "../evidence/refusals.ts";
import { runVerify, type VerifyRun } from "../evidence/runner.ts";
import { failureSignature } from "../evidence/signature.ts";
import { RECEIPT_OUTPUT_BYTES } from "../evidence/verify-env.ts";
import { withTempWorktree } from "../evidence/worktree.ts";
import { afterForgeWrite, type ToolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { invalidText, lockedEvidenceCall, type Precheck, refusedRun, startable, type UnitCall, unitResult, UNIT_PARAMETERS, verifyBlocked } from "./unit-tool.ts";

const TOOL = "unit_finish";
const RETRY = "Debug the failure with the debugging-and-error-recovery skill, commit the fix, then run unit_finish again.";

// --- tick ---------------------------------------------------------------------------------

const DONE_STATUS = "- [x] done";

/** Whether the body shows `unit` ticked with a well-formed status line; a missing unit throws. */
function isDone(body: string, unit: string): boolean {
	const found = parseChange(body).units.find((u) => u.id === unit);
	if (found === undefined) throw new TickError(`unit ${unit} not found`);
	return found.statusText === DONE_STATUS;
}

type TickOutcome = "ticked" | "already" | "conflict" | "cancelled";

/**
 * Ticks `unit` with a version-checked write. On a conflict, re-reads once: a unit already ticked is left
 * alone, else it ticks again. A missing unit, a missing or malformed status line and a transport error
 * propagate; the receipted, unticked unit is reconciled later. A cancellation stops before each write.
 */
async function tick(forge: CachedForge, issue: number, unit: string, cancelled: () => boolean): Promise<TickOutcome> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const current = await forge.getIssue(issue);
		if (attempt > 0 && isDone(current.body, unit)) return "already";
		const body = tickUnit(current.body, unit);
		if (cancelled()) return "cancelled";
		const result = await forge.updateIssueBody(issue, body, current.version);
		if (result.status === "written") return "ticked";
	}
	return "conflict";
}

const tickText = (unit: string, r: Exclude<TickOutcome, "cancelled">): string =>
	r === "conflict" ? `The tick of ${unit} conflicted twice with another edit; run unit_finish ${unit} again to tick it.` : `${unit} is ticked done.`;

// --- pending unit -------------------------------------------------------------------------

type Pre = { sha: string; exit: number; pendingCommit?: string };

/** A cancelled pending check: the same text as an aborted run. */
const CANCELLED = { refused: invalidText({ invalid: "aborted" }, { exit: null }) };

/** The unit's test files in `Files` that are missing at `sha`: the tests a pending unit must add. */
async function pendingTests(c: UnitCall, sha: string): Promise<string[]> {
	const missing: string[] = [];
	for (const path of c.unit.files.filter(isTestFile)) if (!(await c.env.git.pathExistsAt(sha, path))) missing.push(path);
	return missing;
}

/** Why the first commit after a pending start is not a test-only commit adding a pending test, or undefined. */
async function testOnlyRefusal(c: UnitCall, start: StartRecord, first: string): Promise<string | undefined> {
	const { env, unit: u } = c;
	const short = first.slice(0, 7);
	if ((await env.git.parents(first)).length > 1) return `the first commit after the start of ${u.id} (${short}) is a merge commit: commit the failing test alone first.`;
	const only = testOnlyCommitCheck(u, await env.git.changedPaths(first), await pendingTests(c, start.pre.sha));
	if (only.ok) return undefined;
	if ("extra" in only) return `the first commit after the start of ${u.id} (${short}) must change only its test files, but it also changes ${only.extra.join(", ")}.`;
	return `the first commit after the start of ${u.id} (${short}) changes no file of its pending tests (${only.missing.join(", ")}): commit the failing test alone first.`;
}

/** D5: the first commit after the start changes only listed test files, adds a pending one, and is red in a temporary worktree. */
async function pendingPre(c: UnitCall, start: StartRecord): Promise<Pre | { refused: string }> {
	const { env, unit: u } = c;
	const first = (await env.git.revList(`${start.pre.sha}..HEAD`))[0];
	if (c.cancelled() !== undefined) return CANCELLED;
	if (first === undefined) return { refused: `${u.id} is verifier pending, but there is no commit after its start: commit the failing test alone first.` };
	const refusal = await testOnlyRefusal(c, start, first);
	if (c.cancelled() !== undefined) return CANCELLED;
	if (refusal !== undefined) return { refused: refusal };
	const prep = { ...(env.config?.verify?.setup !== undefined ? { setup: env.config.verify.setup } : {}), run: { ...env.run, tailBytes: RECEIPT_OUTPUT_BYTES } };
	const run = await withTempWorktree(env.git, env.root, first, prep, (dir) => runVerify(start.verify, { ...env.run, cwd: dir, tailBytes: RECEIPT_OUTPUT_BYTES }));
	if ("blocked" in run) return { refused: verifyBlocked(u.id, run.blocked) };
	if ("invalid" in run) return { refused: `${invalidText({ invalid: run.invalid }, { exit: null })}\n${unitResult(run.output)}` };
	const cls = classifyRun(run);
	if (typeof cls === "object") return { refused: refusedRun(TOOL, cls, run) };
	if (cls !== "red") return { refused: `Verify passes at the test-only commit ${first.slice(0, 7)}, so the test does not fail before the work; fix the test or Verify with unit_amend.` };
	return { sha: first, exit: run.exit as number, pendingCommit: first };
}

// --- outcomes -----------------------------------------------------------------------------

async function green(c: UnitCall, start: StartRecord, pre: Pre, run: VerifyRun): Promise<ToolResult<undefined>> {
	const { w, state, unit: u } = c;
	const data: ReceiptData = {
		unit: u.id,
		digest: unitDigest(u),
		verify: start.verify,
		pre: { sha: pre.sha, exit: pre.exit },
		post: { sha: state.git.head, exit: run.exit as number },
		output: run.output,
		start: start.id,
	};
	if (pre.pendingCommit !== undefined) data.pending_commit = pre.pendingCommit;
	const beforeReceipt = c.cancelled();
	if (beforeReceipt !== undefined) return beforeReceipt;
	await w.forge.createComment(state.issue.number, receiptComment(newEvidenceId(u.id, new Date()), data));
	// Before the tick: when the tick throws, the next refresh must still see the receipt to reconcile.
	await w.session.comments?.invalidate(state.issue.number);
	const ticked = await tick(w.forge, state.issue.number, u.id, () => c.cancelled() !== undefined);
	await afterForgeWrite(w.session, state.issue.number);
	if (ticked === "cancelled") return c.refuse(`the call was cancelled after the receipt for ${u.id} was posted, before the tick; run unit_finish ${u.id} again to tick it.`);
	return c.done(`Verify passed at ${state.git.head.slice(0, 7)}: receipt posted for ${u.id}. ${tickText(u.id, ticked)}\n${unitResult(run.output)}`);
}

const commentLink = (url: string | undefined, commentId: string): string => (url === undefined ? `comment ${commentId}` : `${url}#issuecomment-${commentId}`);

/** Links to the unit's receipts and failed-attempt records in `state`, plus a record just `posted`, for a stuck report. */
function evidenceLinks(state: ChangeState, unit: string, posted?: string): string[] {
	const url = state.issue.url;
	const receipts = (state.evidence.receipts[unit] ?? []).map((r) => `- receipt ${r.id}: ${commentLink(url, r.commentId)}`);
	const attempts = state.marked.filter((m) => m.kind === "decision" && m.id === `progress.${unit}`).map((m) => `- failed attempt: ${commentLink(url, m.commentId)}`);
	return [...receipts, ...attempts, ...(posted === undefined ? [] : [`- failed attempt: ${commentLink(url, posted)}`])];
}

async function failed(c: UnitCall, start: StartRecord, run: VerifyRun): Promise<ToolResult<undefined>> {
	const { w, state, unit: u } = c;
	const cap = w.pack.loops.unit_attempts ?? Number.POSITIVE_INFINITY;
	const attempt = (state.evidence.attempts[u.id] ?? 0) + 1;
	const signature = failureSignature(run.output);
	const previous = previousSignature(state.marked, u.id, budgetStart(c, start));
	const facts = { attempt, cap, signature, ...(previous === undefined ? {} : { previous }) };
	const decided = await decide("progress", facts, { config: w.pack.decisions.progress ?? { mode: "rule" }, subject: u.id, digest: unitDigest(u) });
	if (decided.status !== "decided") throw new Error("the progress rule never asks");
	const beforeRecord = c.cancelled();
	if (beforeRecord !== undefined) return beforeRecord;
	const record = progressRecord({ unit: u.id, digest: unitDigest(u), start: start.id, attempt, exit: run.exit, postSha: state.git.head, signature, outputTail: run.output, decided });
	const comment = await w.forge.createComment(state.issue.number, decisionComment(record));
	await afterForgeWrite(w.session, state.issue.number);
	const cls = classifyRun(run);
	const what = typeof cls === "object" ? invalidText(cls, run) : `Verify failed (exit ${run.exit}).`;
	const head = `${what} Attempt ${attempt} of ${cap} for ${u.id}; signature ${signature.tests.length === 0 ? "without test names" : `tests ${untrusted(signature.tests.join(", "))}`}, hash ${signature.hash.slice(0, 12)}.`;
	const next = record.outcome === "stop" ? [`${u.id} is now BLOCKED: ${untrusted(decided.reason)}. Send a stuck report with spec_stuck, linking:`, ...evidenceLinks(state, u.id, comment.id)].join("\n") : RETRY;
	return { ...c.done(`${head}\n${next}\n${unitResult(run.output)}`), isError: true };
}

/** The comment index after which `progress` records count towards the current budget. */
function budgetStart(c: UnitCall, start: StartRecord): number {
	const receipt = c.state.evidence.receipts[c.unit.id]?.at(-1)?.index ?? -1;
	const lift = c.state.marked.reduce((last, m, index) => (liftsCap(m) ? index : last), -1);
	return Math.max(start.index, receipt, lift);
}

// --- flow ---------------------------------------------------------------------------------

async function reconcile(c: UnitCall): Promise<ToolResult<undefined>> {
	const ticked = await tick(c.w.forge, c.state.issue.number, c.unit.id, () => c.cancelled() !== undefined);
	if (ticked === "cancelled") return c.refuse(invalidText({ invalid: "aborted" }, { exit: null }));
	await afterForgeWrite(c.w.session, c.state.issue.number);
	return c.done(`${c.unit.id} already has a receipt; no Verify was run. ${tickText(c.unit.id, ticked)}`);
}

async function runFinish(c: UnitCall): Promise<ToolResult<undefined>> {
	const { env, state, unit: u } = c;
	if (finishMode(state, u.id) === "reconcile") return reconcile(c);
	const start = state.evidence.started[u.id] as StartRecord;
	const blocked = env.run.guard(start.verify);
	if (blocked !== undefined) return c.refuse(verifyBlocked(u.id, blocked));
	let pre: Pre | { refused: string } = { sha: start.pre.sha, exit: start.pre.exit ?? 0 };
	if (start.pending === true) pre = await pendingPre(c, start);
	if ("refused" in pre) return c.refuse(pre.refused);
	const run = await runVerify(start.verify, { ...env.run, cwd: env.root, tailBytes: RECEIPT_OUTPUT_BYTES });
	if ("blocked" in run) return c.refuse(verifyBlocked(u.id, run.blocked));
	const cls = classifyRun(run);
	if (typeof cls === "object" && cls.invalid === "aborted") return c.refuse(refusedRun(TOOL, cls, run));
	return postOk(cls) ? green(c, start, pre, run) : failed(c, start, run);
}

/** The D10 refusal; a blocked unit's refusal links its receipts and failed attempts from the refreshed state. */
function precheck(unit: string): (state: ChangeState, pack: Parameters<typeof unitFinishRefusal>[1]) => Precheck {
	return (state, pack) => {
		const refusal = unitFinishRefusal(state, pack, unit, finishMode(state, unit));
		if (refusal === undefined || refusal !== blockedRefusal(state, unit)) return startable(refusal);
		return { refused: [`${refusal} Link this evidence:`, ...evidenceLinks(state, unit)].join("\n") };
	};
}

export function runUnitFinish(unit: string, signal?: AbortSignal): Promise<ToolResult<undefined>> {
	return lockedEvidenceCall(TOOL, unit, signal, precheck(unit), runFinish);
}

export function registerUnitFinish(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Finish a livespec unit",
		description:
			"Finish a started unit: livespec runs its Verify at HEAD. When it passes, a receipt is posted and the unit is ticked done; when it fails, the failed attempt is recorded. A unit with a receipt but no tick is ticked without running Verify. Takes only the unit id.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No outcome, verdict, attempt or exit parameter.
		parameters: UNIT_PARAMETERS as never,
		execute: (_id, params, signal) => runUnitFinish((params as { unit: string }).unit, signal),
	});
}
