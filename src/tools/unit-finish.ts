// `unit_finish { unit }` (design D10): under the evidence lock, either reconciles
// a receipted, unticked unit with a tick, or checks a pending unit's test-only
// commit, runs `Verify` at HEAD, and records a receipt entry plus tick (green) or a
// `progress` decision record (red or invalid).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { unitDigest } from "../core/digest.ts";
import { parseChange } from "../core/change.ts";
import { TickError, tickUnit } from "../core/tick.ts";
import { decisionComment } from "../decide/records.ts";
import { decide } from "../decide/seam.ts";
import type { CachedForge } from "../forge/cache.ts";
import type { Pack } from "../engine/pack-types.ts";
import { phaseFromLabels } from "../engine/snapshot.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { isTestFile, testOnlyCommitCheck } from "../evidence/pending.ts";
import { previousSignature, progressRecord } from "../evidence/progress-rule.ts";
import { newEvidenceId, type ReceiptData, receiptComment, type StartRecord } from "../evidence/records.ts";
import { classifyRun, postOk } from "../evidence/red-green.ts";
import { blockedRefusal, finishMode, notPerUnitText, unitFinishRefusal } from "../evidence/refusals.ts";
import { runVerify, type VerifyRun } from "../evidence/runner.ts";
import { failureSignature } from "../evidence/signature.ts";
import { budgetWindow } from "../evidence/unit-state.ts";
import { RECEIPT_OUTPUT_BYTES } from "../evidence/verify-env.ts";
import { withTempWorktree } from "../evidence/worktree.ts";
import { staleSince, stuckFor } from "../subagents/finish-freshness.ts";
import { finishGateRefusal } from "../subagents/finish-gate.ts";
import type { ApproverCtx } from "./approver-for.ts";
import { runSpecCascade } from "../interaction/spec-cascade.ts";
import { lastForgeRef } from "../ledger/merge.ts";
import { afterForgeWrite, afterLedgerWrite, type ToolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { runSpecStuck } from "./spec-stuck.ts";
import { invalidText, lockedEvidenceCall, type Precheck, type PrecheckFn, refusedRun, startable, type UnitCall, unitResult, UNIT_PARAMETERS, verifyBlocked } from "./unit-tool.ts";

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

type TickOutcome = "ticked" | "already" | "conflict" | "cancelled" | { moved: string };

/**
 * Ticks `unit` with a version-checked write. On a conflict, re-reads once: a unit already ticked is left
 * alone, else it ticks again. A missing unit, a missing or malformed status line and a transport error
 * propagate; the receipted, unticked unit is reconciled later. A cancellation stops before each write.
 * The labels read with each body are checked first: a change that left its `per: unit` phase is not ticked.
 */
async function tick(forge: CachedForge, issue: number, unit: string, pack: Pack, cancelled: () => boolean): Promise<TickOutcome> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const current = await forge.getIssue(issue);
		const moved = notPerUnitText(phaseFromLabels(current.labels), pack);
		if (moved !== undefined) return { moved };
		if (attempt > 0 && isDone(current.body, unit)) return "already";
		const body = tickUnit(current.body, unit);
		if (cancelled()) return "cancelled";
		const result = await forge.updateIssueBody(issue, body, current.version);
		if (result.status === "written") return "ticked";
	}
	return "conflict";
}

const tickText = (unit: string, r: Exclude<TickOutcome, "cancelled" | { moved: string }>): string =>
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
		start: start.commentId,
	};
	if (pre.pendingCommit !== undefined) data.pending_commit = pre.pendingCommit;
	const beforeReceipt = c.cancelled();
	if (beforeReceipt !== undefined) return beforeReceipt;
	await w.ledger.append(state.issue.number, { ...receiptComment(newEvidenceId(u.id, new Date()), data), after: lastForgeRef(state.marked) });
	// Before the tick: when the tick throws, the next refresh must still see the receipt to reconcile.
	await afterLedgerWrite(w.session, state.issue.number);
	const ticked = await tick(w.forge, state.issue.number, u.id, c.pack, () => c.cancelled() !== undefined);
	await afterForgeWrite(w.session, state.issue.number);
	if (typeof ticked === "object") return c.refuse(`${ticked.moved} The receipt for ${u.id} is posted; run unit_finish ${u.id} again in a per: unit phase to tick it.`);
	if (ticked === "cancelled") return c.refuse(`the call was cancelled after the receipt for ${u.id} was posted, before the tick; run unit_finish ${u.id} again to tick it.`);
	return c.done(`Verify passed at ${state.git.head.slice(0, 7)}: receipt posted for ${u.id}. ${tickText(u.id, ticked)}\n${unitResult(run.output)}`);
}

/** A ledger entry as `ledger:<issue>/<ref>`; a forge comment (an older record) as its link. */
function recordLink(state: ChangeState, ref: string): string {
	if (state.marked.find((m) => m.ref === ref)?.source === "forge") return state.issue.url === undefined ? `comment ${ref}` : `${state.issue.url}#issuecomment-${ref}`;
	return `ledger:${state.issue.number}/${ref}`;
}

/** Links to the unit's receipts and failed-attempt records in `state`, plus a record just `posted`, for a stuck report. */
function evidenceLinks(state: ChangeState, unit: string, posted?: string): string[] {
	const receipts = (state.evidence.receipts[unit] ?? []).map((r) => `- receipt ${r.id}: ${recordLink(state, r.commentId)}`);
	const attempts = state.marked.filter((m) => m.kind === "decision" && m.id === `progress.${unit}`).map((m) => `- failed attempt: ${recordLink(state, m.ref)}`);
	return [...receipts, ...attempts, ...(posted === undefined ? [] : [`- failed attempt: ledger:${state.issue.number}/${posted}`])];
}

/** Posts the `progress` record of a red or invalid run at `postSha` (HEAD by default) as a failed attempt; `lane_merge` reuses it. */
export async function failed(c: UnitCall, start: StartRecord, run: VerifyRun, postSha: string = c.state.git.head): Promise<ToolResult<undefined>> {
	const { w, state, unit: u } = c;
	const cap = w.pack.loops.unit_attempts ?? Number.POSITIVE_INFINITY;
	const attempt = (state.evidence.attempts[u.id] ?? 0) + 1;
	const signature = failureSignature(run.output);
	const previous = previousSignature(state.marked, u.id, budgetWindow(state.marked, u.id));
	const facts = { attempt, cap, signature, ...(previous === undefined ? {} : { previous }) };
	const decided = await decide("progress", facts, { config: w.pack.decisions.progress, subject: u.id, digest: unitDigest(u) });
	if (decided.status !== "decided") throw new Error("the progress rule never asks");
	const beforeRecord = c.cancelled();
	if (beforeRecord !== undefined) return beforeRecord;
	const record = progressRecord({ unit: u.id, digest: unitDigest(u), start: start.id, attempt, exit: run.exit, postSha, signature, outputTail: run.output, decided });
	const entry = await w.ledger.append(state.issue.number, { ...decisionComment(record), after: lastForgeRef(state.marked) });
	await afterLedgerWrite(w.session, state.issue.number);
	const cls = classifyRun(run);
	const what = typeof cls === "object" ? invalidText(cls, run) : `Verify failed (exit ${run.exit}).`;
	const head = `${what} Attempt ${attempt} of ${cap} for ${u.id}; signature ${signature.tests.length === 0 ? "without test names" : `tests ${untrusted(signature.tests.join(", "))}`}, hash ${signature.hash.slice(0, 12)}.`;
	const next = record.outcome === "stop" ? [`${u.id} is now BLOCKED: ${untrusted(decided.reason)}. Send a stuck report with spec_stuck, linking:`, ...evidenceLinks(state, u.id, entry.ref)].join("\n") : RETRY;
	return { ...c.done(`${head}\n${next}\n${unitResult(run.output)}`), isError: true };
}

// --- flow ---------------------------------------------------------------------------------

async function reconcile(c: UnitCall): Promise<ToolResult<undefined>> {
	const ticked = await tick(c.w.forge, c.state.issue.number, c.unit.id, c.pack, () => c.cancelled() !== undefined);
	if (typeof ticked === "object") return c.refuse(ticked.moved);
	if (ticked === "cancelled") return c.refuse(invalidText({ invalid: "aborted" }, { exit: null }));
	await afterForgeWrite(c.w.session, c.state.issue.number);
	return c.done(`${c.unit.id} already has a receipt; no Verify was run. ${tickText(c.unit.id, ticked)}`);
}

/** The stale sources of the unit's last packet; nothing is sent here, because a human request must never wait under the evidence lock. */
type Staleness = { stale?: string[] };

async function staleStop(c: UnitCall, found: Staleness): Promise<ToolResult<undefined> | undefined> {
	const { w, state, env, unit: u } = c;
	const stale = await staleSince({ session: w.session, state, pack: w.pack, forge: w.forge, git: env.git, root: env.root, cwd: env.root, budgetTokens: w.session.config.user.packetBudgetTokens }, u.id);
	if (stale === undefined) return undefined;
	const cancelled = c.cancelled();
	if (cancelled !== undefined) return cancelled;
	found.stale = stale;
	return c.refuse(`${staleHead(u.id, stale)} Report it with spec_stuck.`);
}

const staleHead = (unit: string, stale: string[]): string => `unit_finish refused: ${unit} is not ticked; its dispatched packet is stale (${stale.join(", ")}).`;

/** After the lock: the stale report goes to the human through `spec_stuck`, and its text follows the refusal. */
async function reportStale(unit: string, stale: string[], ctx: ApproverCtx): Promise<ToolResult<undefined>> {
	const sent = await runSpecStuck(stuckFor(unit, stale), ctx);
	return { ...sent, content: [{ type: "text", text: `${staleHead(unit, stale)}\n${sent.content.map((x) => x.text).join("\n")}` }], isError: true };
}

async function runFinish(c: UnitCall, found: Staleness): Promise<ToolResult<undefined>> {
	const { env, state, unit: u } = c;
	const stale = await staleStop(c, found);
	if (stale !== undefined) return stale;
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
function precheck(unit: string): PrecheckFn {
	return async (state, pack, git) => {
		const phase = notPerUnitText(state.phase, pack);
		if (phase !== undefined) return { refused: phase };
		const gate = await finishGateRefusal(state, pack, unit, git);
		if (gate !== undefined) return { refused: gate };
		const refusal = unitFinishRefusal(state, pack, unit, finishMode(state, unit));
		if (refusal === undefined || refusal !== blockedRefusal(state, unit)) return startable(refusal);
		return { refused: [`${refusal} Link this evidence:`, ...evidenceLinks(state, unit)].join("\n") };
	};
}

export async function runUnitFinish(unit: string, signal?: AbortSignal, ctx?: ApproverCtx): Promise<ToolResult<undefined>> {
	const found: Staleness = {};
	// The cascade runs under the evidence lock, before the change is resolved (design D7).
	const before = async (w: WriteContext): Promise<void> => void (await runSpecCascade(w.session));
	const result = await lockedEvidenceCall(TOOL, unit, signal, precheck(unit), (c) => runFinish(c, found), { before });
	return found.stale !== undefined && ctx !== undefined ? reportStale(unit, found.stale, ctx) : result;
}

export function registerUnitFinish(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Finish a livespec unit",
		description:
			"Finish a started unit: livespec runs its Verify at HEAD. When it passes, a receipt is posted and the unit is ticked done; when it fails, the failed attempt is recorded. A unit with a receipt but no tick is ticked without running Verify. Takes only the unit id.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No outcome, verdict, attempt or exit parameter.
		parameters: UNIT_PARAMETERS as never,
		execute: (_id, params, signal, _update, ctx) => runUnitFinish((params as { unit: string }).unit, signal, ctx as ApproverCtx),
	});
}
