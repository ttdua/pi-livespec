// The effect side of the spec-diff requirement cascade (design D2, D3, D5): reads the planner's input fresh,
// applies one plan in the order `stale` comment, one versioned untick, move back to define, then re-reads and
// plans once more. Single-flight per session; never throws: errors go to `session.record`.

import { type Change, parseChange } from "../core/change.ts";
import { untickUnit } from "../core/tick.ts";
import { advancePhase } from "../engine/advance.ts";
import { type Git, integrationBranch } from "../engine/git.ts";
import { deriveLocks } from "../engine/locks.ts";
import type { Pack } from "../engine/pack-types.ts";
import { changedIds, requirementDigests, requirementScope } from "../engine/requirement-diff.ts";
import { phaseFromLabels } from "../engine/snapshot.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { CachedForge } from "../forge/cache.ts";
import { type MarkedComment, readMarkedComments, writeMarked } from "../forge/markers.ts";
import type { Session } from "../hooks/session.ts";
import { acknowledgedDigests, type CascadeInput, planSpecCascade, type SpecCascadePlan } from "./spec-cascade-plan.ts";

const STEP = "spec-cascade";
const REMOTE = "origin";
const DEFINE = "define";
const HEAD = "HEAD";

type Target = { session: Session; forge: CachedForge; pack: Pack; state: ChangeState };

/** The connected, writable, current change, as `pollTarget` guards it; undefined means skip. */
function cascadeTarget(session: Session): Target | undefined {
	const { forge, card } = session;
	if (!forge || forge.isReadOnly() || session.accountBlock !== undefined || !session.pack.ok) return undefined;
	if (card.kind !== "change" || card.state.stale) return undefined;
	return { session, forge, pack: session.pack.pack, state: card.state };
}

// --- reading the input -------------------------------------------------------------

/**
 * The integration reference: `merge-base(HEAD, origin/<branch>)` after a best-effort fetch, else `base` when that
 * commit exists, else undefined (no exclusion).
 */
export async function integrationRef(session: Session, git: Git, base: string | undefined): Promise<string | undefined> {
	const project = session.config.project;
	const branch = project === null ? undefined : await integrationBranch(project, git);
	if (branch !== undefined) {
		// Best effort under the git runner's timeout: offline, the local ref is used.
		await git.fetch(REMOTE, branch).catch(() => undefined);
		const ref = `${REMOTE}/${branch}`;
		if ((await git.remoteRef(ref)) !== undefined) {
			const mergeBase = await git.mergeBase(HEAD, ref).catch(() => undefined);
			if (mergeBase !== undefined) return mergeBase;
		}
	}
	return base !== undefined && (await git.hasCommit(base)) ? base : undefined;
}

/** The lock gate's record, else the digests at its `head_sha` while that commit exists, else undefined. */
async function baselineOf(git: Git, lock: CascadeInput["lock"], change: Change): Promise<Record<string, string> | undefined> {
	const gate = lock.baseline;
	if (gate === undefined) return undefined;
	if (gate.requirements !== undefined) return gate.requirements;
	if (gate.headSha === undefined || !(await git.hasCommit(gate.headSha))) return undefined;
	return requirementDigests(git, gate.headSha, requirementScope(change));
}

/** The planner's input, read fresh; digests only with a known baseline, the reference only when something changed. */
async function readCascadeInput(t: Target): Promise<CascadeInput> {
	const n = t.state.issue.number;
	const git = t.session.git;
	await t.session.comments?.invalidate(n);
	const [issue, { comments: marked }] = await Promise.all([t.forge.getIssue(n), readMarkedComments(t.forge, n)]);
	const change = parseChange(issue.body);
	const lock = deriveLocks(change, marked);
	const baseline = await baselineOf(git, lock, change);
	const scope = lock.baseline?.scope ?? requirementScope(change);
	const input: CascadeInput = { change, marked, phase: phaseFromLabels(issue.labels), pack: t.pack, lock, baseline, scope, heads: {}, reference: undefined };
	if (baseline === undefined) return input;
	input.heads = await requirementDigests(git, HEAD, scope);
	if (changedIds(acknowledgedDigests(input), input.heads).length === 0) return input;
	const ref = await integrationRef(t.session, git, change.header.base);
	if (ref !== undefined) input.reference = await requirementDigests(git, ref, scope);
	return input;
}

// --- applying a plan ---------------------------------------------------------------------

/** One run over a target; `wrote` turns true at the first forge write, so a later failure still refreshes. */
type Run = Target & { wrote: boolean };

/** Posts the plan's `stale` comment unless an own comment with its id exists. */
async function postStale(r: Run, marked: MarkedComment[], plan: Extract<SpecCascadePlan, { id: string }>): Promise<void> {
	if (marked.some((m) => m.kind === "stale" && m.id === plan.id)) return;
	await r.forge.createComment(r.state.issue.number, writeMarked("stale", plan.id, plan.data));
	r.wrote = true;
}

/** One versioned body write unticking the planned units still done; false on a conflict, which the next run retries. */
async function untickUnits(r: Run, units: string[]): Promise<boolean> {
	const n = r.state.issue.number;
	const issue = await r.forge.getIssue(n);
	const done = new Set(parseChange(issue.body).units.filter((u) => u.done).map((u) => u.id));
	const body = units.filter((u) => done.has(u)).reduce((b, unit) => untickUnit(b, unit), issue.body);
	if (body === issue.body) return true;
	const written = await r.forge.updateIssueBody(n, body, issue.version);
	if (written.status === "conflict") {
		r.session.record(STEP, `#${n} changed while ${units.join(", ")} were unticked (${written.changed.join(", ")}); the next run retries`);
		return false;
	}
	r.wrote = true;
	return true;
}

async function moveBack(r: Run): Promise<void> {
	const moved = await advancePhase(r.forge, r.state.issue.number, DEFINE, r.pack);
	if (moved.status === "refused") throw new Error(`cannot move the change back to define: ${moved.reason}`);
	if (moved.status === "moved") r.wrote = true;
}

/** `stale` comment, then untick, then the move; false when the plan was none or a body conflict stopped it. */
async function applyCascade(r: Run, input: CascadeInput, plan: SpecCascadePlan): Promise<boolean> {
	if (plan.kind === "none") return false;
	if (plan.kind !== "complete") await postStale(r, input.marked, plan);
	if (plan.kind !== "legacy-missing" && !(await untickUnits(r, plan.untick))) return false;
	if (plan.moveBack) await moveBack(r);
	return true;
}

// --- run ----------------------------------------------------------------------------------

/** Plans applied per run: one, then a re-read and one more, so a completion and a new cascade land in one trigger. */
const PASSES = 2;

async function cascadeChange(t: Target): Promise<boolean> {
	const r: Run = { ...t, wrote: false };
	try {
		for (let pass = 0; pass < PASSES; pass++) {
			const input = await readCascadeInput(r);
			if (!(await applyCascade(r, input, planSpecCascade(input)))) break;
		}
	} catch (error) {
		r.session.record(STEP, error);
	}
	if (r.wrote) {
		// The writes stand even when the refresh fails: report them, record the failure.
		try {
			await r.session.comments?.invalidate(r.state.issue.number);
			await r.session.refresh();
		} catch (error) {
			r.session.record(STEP, error);
		}
	}
	return r.wrote;
}

async function runOnce(session: Session): Promise<boolean> {
	try {
		const target = cascadeTarget(session);
		return target === undefined ? false : await cascadeChange(target);
	} catch (error) {
		session.record(STEP, error);
		return false;
	}
}

/**
 * Cascades requirement edits since the plan lock; true when it wrote. Never throws. Single-flight per session:
 * concurrent triggers await the same run. Runs from other sessions or machines are not coordinated (known gap).
 */
export function runSpecCascade(session: Session): Promise<boolean> {
	session.cascadeInFlight ??= runOnce(session).finally(() => {
		session.cascadeInFlight = undefined;
	});
	return session.cascadeInFlight;
}
