// `change_sync` core (design D12), shared with `change_resume`: merge the integration branch, re-run every
// done unit's `Verify` into one `regression` record, mark and untick the units that regressed or whose covered
// requirement changed in the living specs between the old and the new base, and move `Base` last.
//
// Write order is what makes a rerun safe: the issue `Base` stays the old base until every other effect is
// written, so a failure anywhere before it leaves the requirement diff intact for the rerun; the `stale`
// comment precedes the untick, so a unit is never pending with a matching receipt and no stale mark (which
// `unit_finish` would re-tick without running `Verify`); records are posted once per HEAD.

import type { Unit } from "../core/change.ts";
// Side effect: registers the `regression` marker kind, so `writeMarked` accepts it outside the extension entry.
import "../deps/markers.ts";
import { parseChange } from "../core/change.ts";
import { setHeaderLine } from "../core/sections.ts";
import { untickUnit } from "../core/tick.ts";
import { advancePhase } from "../engine/advance.ts";
import { type Git, integrationBranch } from "../engine/git.ts";
import type { Pack } from "../engine/pack-types.ts";
import { capabilityOf, changedIds, coversId, requirementDigests } from "../engine/requirement-diff.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { classifyRun } from "../evidence/red-green.ts";
import { runVerify } from "../evidence/runner.ts";
import { RECEIPT_OUTPUT_BYTES, type VerifyEnv, verifyEnv } from "../evidence/verify-env.ts";
import type { CachedForge } from "../forge/cache.ts";
import { readMarkedComments, writeMarked } from "../forge/markers.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { Session } from "../hooks/session.ts";
import { phasesAfter } from "../interaction/complete-effects.ts";
import { staleComment } from "../interaction/stale.ts";
import { livespecBaseKey } from "../tools/change-start.ts";

export type SyncContext = { session: Session; forge: CachedForge; state: ChangeState; signal?: AbortSignal };
export type SyncResult = { base: string; stale: string[] } | { refused: string };

export type RegressionUnit = { unit: string; exit: number | null; verdict: "green" | "red" | "invalid"; tail: string };
export type RegressionData = { base_from: string; base_to: string; head: string; units: RegressionUnit[] };

const REMOTE = "origin";
const BUILD_PHASE = "build";
const BASE_KEY = "Base";

/** `own` holds the ids of own marked comments, read fresh, so a rerun at the same HEAD posts nothing twice. */
type Synced = { ctx: SyncContext; pack: Pack; git: Git; oldBase: string; base: string; head: string; own: Set<string> };

const markedKey = (kind: string, id: string): string => `${kind}\0${id}`;

/** Posts an own marked comment unless one of `kind`/`id` already exists. */
async function postOnce(s: Synced, kind: string, id: string, body: string): Promise<void> {
	if (s.own.has(markedKey(kind, id))) return;
	await s.ctx.forge.createComment(s.ctx.state.issue.number, body);
	s.own.add(markedKey(kind, id));
}

// --- refusals ------------------------------------------------------------------

async function preconditionRefusal(ctx: SyncContext, git: Git): Promise<string | undefined> {
	const { state } = ctx;
	const branch = state.change.header.branch;
	if (branch === undefined || state.git.branch !== branch) return `run it on the change branch${branch === undefined ? "" : ` ${untrusted(branch)}`}; HEAD is on ${untrusted(state.git.branch || "(detached)")}.`;
	if (await git.isDirty()) return "the working tree has uncommitted changes; commit or stash them, then rerun.";
	const started = state.change.units.find((u) => u.id in state.evidence.started);
	if (started) return `${started.id} is started; finish it with unit_finish before syncing.`;
	if (state.change.header.base === undefined) return "the issue records no Base.";
	return undefined;
}

// --- step 1: merge ----------------------------------------------------------------

/** Step 1: fetch, then merge the integration tip unless HEAD already contains it; a conflict is aborted. */
async function mergeIntegration(git: Git, integration: string): Promise<{ base: string } | { refused: string }> {
	await git.fetch(REMOTE, integration);
	const ref = `${REMOTE}/${integration}`;
	const base = await git.revParse(ref);
	if (await git.isAncestor(base, "HEAD")) return { base };
	if ((await git.mergeOrigin(ref)) === "ok") return { base };
	await git.mergeAbort();
	return { refused: `merging ${ref} conflicts; the merge was aborted and nothing changed. Merge ${ref} by hand, resolve the conflicts and commit, then rerun change_sync.` };
}

// --- step 3: regression record ---------------------------------------------------

async function verifyUnit(env: VerifyEnv, unit: Unit): Promise<RegressionUnit> {
	if (unit.verify === undefined) return { unit: unit.id, exit: null, verdict: "invalid", tail: "no Verify command" };
	const run = await runVerify(unit.verify, { cwd: env.root, ...env.run, tailBytes: RECEIPT_OUTPUT_BYTES });
	if ("blocked" in run) return { unit: unit.id, exit: null, verdict: "invalid", tail: `blocked: ${run.blocked}` };
	const cls = classifyRun(run);
	return { unit: unit.id, exit: run.exit, verdict: typeof cls === "string" ? cls : "invalid", tail: run.output };
}

/** Runs every done unit's `Verify` at HEAD, one after another; undefined when the run was aborted. */
async function regressionRuns(s: Synced): Promise<RegressionUnit[] | undefined> {
	const env = await verifyEnv(s.ctx.session, s.ctx.signal);
	const results: RegressionUnit[] = [];
	for (const unit of s.ctx.state.change.units.filter((u) => u.done)) {
		results.push(await verifyUnit(env, unit));
		if (env.run.signal?.aborted) return undefined;
	}
	return results;
}

// --- step 4: stale units ---------------------------------------------------------

/** Requirement ids whose content differs between the bases, for the capabilities the done units cover. */
async function changedRequirementIds(s: Synced, done: Unit[]): Promise<Set<string>> {
	if (s.oldBase === s.base) return new Set();
	const caps = [...new Set(done.flatMap((u) => u.covers.map(capabilityOf)).filter((c): c is string => c !== undefined))];
	const before = await requirementDigests(s.git, s.oldBase, caps);
	const after = await requirementDigests(s.git, s.base, caps);
	return new Set(changedIds(before, after));
}

/** Done units whose run was not green, or whose `Covers` names a requirement changed between the bases, in unit order. */
async function staleUnits(s: Synced, runs: RegressionUnit[]): Promise<string[]> {
	const done = s.ctx.state.change.units.filter((u) => u.done);
	const changed = await changedRequirementIds(s, done);
	const red = new Set(runs.filter((r) => r.verdict !== "green").map((r) => r.unit));
	return done.filter((u) => red.has(u.id) || u.covers.some((c) => changed.has(coversId(c)))).map((u) => u.id);
}

/**
 * The `stale` comment first, then one versioned untick of the units still done, then a later phase back to
 * build. A conflict on the untick refuses; the stale mark already blocks the units until they are amended.
 */
async function markStale(s: Synced, units: string[]): Promise<string | undefined> {
	const { forge, state } = s.ctx;
	const n = state.issue.number;
	const later = phasesAfter(s.pack, BUILD_PHASE);
	const past = state.phase.kind === "ok" && later.includes(state.phase.id);
	const id = `stale.sync.${s.head}`;
	const reason = `regression after syncing to ${REMOTE} ${s.base}`;
	await postOnce(s, "stale", id, staleComment(id, { reason, phases: past ? later : [], units }));
	const issue = await forge.getIssue(n);
	const done = new Set(parseChange(issue.body).units.filter((u) => u.done).map((u) => u.id));
	const body = units.filter((u) => done.has(u)).reduce((b, unit) => untickUnit(b, unit), issue.body);
	if (body !== issue.body) {
		const written = await forge.updateIssueBody(n, body, issue.version);
		if (written.status === "conflict") return `#${n} changed while ${units.join(", ")} were unticked (${written.changed.join(", ")}); Base is unchanged, rerun change_sync.`;
	}
	if (past) await advancePhase(forge, n, BUILD_PHASE, s.pack);
	return undefined;
}

// --- last: move Base ---------------------------------------------------------------

/** The issue `Base` (versioned, skipped when equal), then the `livespecBase` git config, as plan_units does. */
async function recordBase(s: Synced): Promise<string | undefined> {
	const n = s.ctx.state.issue.number;
	const issue = await s.ctx.forge.getIssue(n);
	if (parseChange(issue.body).header.base !== s.base) {
		const written = await s.ctx.forge.updateIssueBody(n, setHeaderLine(issue.body, BASE_KEY, s.base), issue.version);
		if (written.status === "conflict") return `#${n} changed while Base was written (${written.changed.join(", ")}); Base is unchanged, rerun change_sync.`;
	}
	await s.git.configSet(livespecBaseKey(s.ctx.state.change.header.branch as string), s.base);
	return undefined;
}

// --- syncChange ------------------------------------------------------------------

/** D12 steps 1, 3 and 4, then step 2 (Base) last. Every refusal before the merge leaves HEAD, Base and the issue unchanged. */
export async function syncChange(ctx: SyncContext): Promise<SyncResult> {
	const { session, state } = ctx;
	const git = session.git;
	if (!session.pack.ok) return { refused: "the flow pack is not valid." };
	const pre = await preconditionRefusal(ctx, git);
	if (pre !== undefined) return { refused: pre };
	const project = session.config.project;
	const integration = project === null ? undefined : await integrationBranch(project, git);
	if (integration === undefined) return { refused: "the integration branch is unknown: origin/HEAD is not set. Set integrationBranch in .pi/livespec/config.yaml." };
	const merged = await mergeIntegration(git, integration);
	if ("refused" in merged) return merged;
	const own = new Set((await readMarkedComments(ctx.forge, state.issue.number)).comments.map((m) => markedKey(m.kind, m.id)));
	const s: Synced = { ctx, pack: session.pack.pack, git, oldBase: state.change.header.base as string, base: merged.base, head: await git.head(), own };
	return regressAndMark(s);
}

async function regressAndMark(s: Synced): Promise<SyncResult> {
	const runs = await regressionRuns(s);
	if (runs === undefined) return { refused: "Verify was aborted (the tool call was cancelled or the session is shutting down); no regression record was written. Rerun change_sync." };
	const data: RegressionData = { base_from: s.oldBase, base_to: s.base, head: s.head, units: runs };
	const id = `regression.${s.head}`;
	await postOnce(s, "regression", id, writeMarked("regression", id, data));
	const stale = await staleUnits(s, runs);
	const failure = (stale.length === 0 ? undefined : await markStale(s, stale)) ?? (await recordBase(s));
	return failure === undefined ? { base: s.base, stale } : { refused: failure };
}
