// `change_sync` core (design D12), shared with `change_resume`: merge the integration branch, move `Base`,
// re-run every done unit's `Verify` into one `regression` record, and untick the units that regressed or
// whose covered requirement changed in the living specs between the old and the new base.

import type { Unit } from "../core/change.ts";
import "../deps/markers.ts";
import { parseChange } from "../core/change.ts";
import { setHeaderLine } from "../core/sections.ts";
import { parseSpec } from "../core/spec.ts";
import { untickUnit } from "../core/tick.ts";
import { advancePhase } from "../engine/advance.ts";
import { type Git, integrationBranch } from "../engine/git.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { classifyRun } from "../evidence/red-green.ts";
import { runVerify } from "../evidence/runner.ts";
import { RECEIPT_OUTPUT_BYTES, type VerifyEnv, verifyEnv } from "../evidence/verify-env.ts";
import type { CachedForge } from "../forge/cache.ts";
import { writeMarked } from "../forge/markers.ts";
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
const COVERS_SEPARATOR = "/Requirement:";

type Synced = { ctx: SyncContext; pack: Pack; git: Git; oldBase: string; base: string; head: string };

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

// --- steps 1 and 2: merge and move Base ------------------------------------------

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

/** Step 2: `Base` in the issue (versioned) and the `livespecBase` git config. */
async function recordBase(ctx: SyncContext, git: Git, base: string): Promise<string | undefined> {
	const n = ctx.state.issue.number;
	await git.configSet(livespecBaseKey(ctx.state.change.header.branch as string), base);
	const issue = await ctx.forge.getIssue(n);
	if (parseChange(issue.body).header.base === base) return undefined;
	const written = await ctx.forge.updateIssueBody(n, setHeaderLine(issue.body, BASE_KEY, base), issue.version);
	return written.status === "conflict" ? `#${n} changed while Base was written (${written.changed.join(", ")}); rerun change_sync.` : undefined;
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

type Requirements = Map<string, string>;

/** Requirement name to text of `specs/<capability>/spec.md` at `rev`; empty when the file is absent. */
async function requirementsAt(git: Git, rev: string, capability: string): Promise<Requirements> {
	const text = await git.showFile(rev, `specs/${capability}/spec.md`);
	return new Map(text === undefined ? [] : parseSpec(text, capability).requirements.map((r) => [r.name, r.text]));
}

/** `<capability>/Requirement: <name>` entries added, removed or changed in text between the bases. */
async function changedRequirements(s: Synced, covers: string[]): Promise<Set<string>> {
	const changed = new Set<string>();
	const capabilities = [...new Set(covers.map((c) => c.split(COVERS_SEPARATOR)[0]?.trim() ?? ""))].filter((c) => c !== "");
	for (const capability of capabilities) {
		const [before, after] = await Promise.all([requirementsAt(s.git, s.oldBase, capability), requirementsAt(s.git, s.base, capability)]);
		for (const name of new Set([...before.keys(), ...after.keys()])) {
			if (before.get(name) !== after.get(name)) changed.add(`${capability}${COVERS_SEPARATOR} ${name}`);
		}
	}
	return changed;
}

/** Done units whose run was not green, or whose `Covers` names a changed requirement, in unit order. */
async function staleUnits(s: Synced, runs: RegressionUnit[]): Promise<string[]> {
	const done = s.ctx.state.change.units.filter((u) => u.done);
	const changed = s.oldBase === s.base ? new Set<string>() : await changedRequirements(s, done.flatMap((u) => u.covers));
	const red = new Set(runs.filter((r) => r.verdict !== "green").map((r) => r.unit));
	return done.filter((u) => red.has(u.id) || u.covers.some((c) => changed.has(c.trim()))).map((u) => u.id);
}

/** Unticks `units` in one versioned write, posts the `stale` comment and moves a later phase back to build. */
async function markStale(s: Synced, units: string[]): Promise<string | undefined> {
	const { forge, state } = s.ctx;
	const n = state.issue.number;
	const issue = await forge.getIssue(n);
	const body = units.reduce((b, unit) => untickUnit(b, unit), issue.body);
	const written = await forge.updateIssueBody(n, body, issue.version);
	if (written.status === "conflict") return `#${n} changed while ${units.join(", ")} were unticked (${written.changed.join(", ")}); rerun change_sync.`;
	const later = phasesAfter(s.pack, BUILD_PHASE);
	const past = state.phase.kind === "ok" && later.includes(state.phase.id);
	const reason = `regression after syncing to ${REMOTE} ${s.base}`;
	await forge.createComment(n, staleComment(`stale.sync.${s.head}`, { reason, phases: past ? later : [], units }));
	if (past) await advancePhase(forge, n, BUILD_PHASE, s.pack);
	return undefined;
}

// --- syncChange ------------------------------------------------------------------

/** D12 steps 1 to 4. Every refusal before the merge leaves HEAD, Base and the issue unchanged. */
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
	const baseFailure = await recordBase(ctx, git, merged.base);
	if (baseFailure !== undefined) return { refused: baseFailure };
	const s: Synced = { ctx, pack: session.pack.pack, git, oldBase: state.change.header.base as string, base: merged.base, head: await git.head() };
	return regressAndMark(s);
}

async function regressAndMark(s: Synced): Promise<SyncResult> {
	const runs = await regressionRuns(s);
	if (runs === undefined) return { refused: "Verify was aborted (the tool call was cancelled or the session is shutting down); no regression record was written. Rerun change_sync." };
	const data: RegressionData = { base_from: s.oldBase, base_to: s.base, head: s.head, units: runs };
	await s.ctx.forge.createComment(s.ctx.state.issue.number, writeMarked("regression", `regression.${s.head}`, data));
	const stale = await staleUnits(s, runs);
	if (stale.length === 0) return { base: s.base, stale };
	const failure = await markStale(s, stale);
	return failure === undefined ? { base: s.base, stale } : { refused: failure };
}
