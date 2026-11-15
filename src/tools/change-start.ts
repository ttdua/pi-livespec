// `change_start #N`: fetches the integration branch, creates and switches to
// `livespec/<name>` at its head, stores that head in git config, then records
// `Branch:` and `Base:` in the issue with a version check. It never pushes.
//
// Only a version conflict is a definite rejection (roll the branch back); any
// thrown write error is an unknown outcome, settled by re-reading the issue.
// A rerun with the branch and its `livespecBase` config key reconciles.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseChange } from "../core/change.ts";
import { messageOf } from "../core/messages.ts";
import { isKebabName } from "../core/names.ts";
import { setHeaderLine } from "../core/sections.ts";
import { type Git, integrationBranch } from "../engine/git.ts";
import type { CachedForge } from "../forge/cache.ts";
import { LABEL_LIVESPEC } from "../forge/labels.ts";
import type { Issue } from "../forge/types.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { afterForgeWrite, prepareWrite, requireWritable, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";

export type ChangeStartParams = { issue: number };
/** Set in full on success; empty on a refusal or failure. */
export type ChangeStartDetails = { branch?: string; base?: string; reconciled?: boolean };

const BRANCH_PREFIX = "livespec/";
const REMOTE = "origin";
const BRANCH_KEY = "Branch";
const BASE_KEY = "Base";

export const livespecBaseKey = (branch: string): string => `branch.${branch}.livespecBase`;

type Started = { issue: Issue; branch: string };
type Result = ToolResult<ChangeStartDetails>;

const refuse = (message: string): Result => toolResult(message, {}, true);
const success = (text: string, branch: string, base: string, reconciled: boolean): Result =>
	toolResult(text, { branch, base, reconciled });

function rerunHint(n: number): string {
	return `The branch is kept; rerun change_start #${n} once the forge is reachable to reconcile.`;
}

// --- validateStart -------------------------------------------------------------

type StartPlan = { kind: "create"; start: Started } | { kind: "reconcile"; start: Started; base: string } | { kind: "refused"; message: string };

function issueRefusal(issue: Issue): string | undefined {
	if (issue.state !== "open" || !issue.labels.includes(LABEL_LIVESPEC)) return `#${issue.number} is not an open livespec change.`;
	if (!isKebabName(issue.title)) return `The title of #${issue.number} is not a kebab-case change name, so no branch name follows from it.`;
	return undefined;
}

const STALE_ISSUE =
	"The issue could only be read from the cache (the forge is in read-only mode), so change_start makes no branch. Retry once the forge is reachable.";

/**
 * The validation read may fall back to a stale cached issue and switch the forge to read-only mode, so
 * the forge is checked again right after it, before any other git command.
 */
function forgeRefusal(w: WriteContext, issue: Issue): string | undefined {
	const writable = requireWritable(w.session);
	if (!writable.ok) return writable.message;
	return issue.stale ? STALE_ISSUE : undefined;
}

/** Every refusal of change_start; it runs only read-only git commands. */
async function validateStart(w: WriteContext, n: number): Promise<StartPlan> {
	const git = w.session.git;
	const issue = await w.forge.getIssue(n);
	const offline = forgeRefusal(w, issue);
	if (offline) return { kind: "refused", message: offline };
	const bad = issueRefusal(issue);
	if (bad) return { kind: "refused", message: bad };
	if (await git.isDirty()) return { kind: "refused", message: "The working tree has uncommitted changes; commit or stash them, then rerun change_start." };
	const branch = `${BRANCH_PREFIX}${issue.title}`;
	const start = { issue, branch };
	if (await git.branchExists(branch)) {
		const base = await git.configGet(livespecBaseKey(branch));
		if (base === undefined) {
			return { kind: "refused", message: `The local branch ${branch} exists without ${livespecBaseKey(branch)}, so livespec did not create it. Rename or delete it, then rerun.` };
		}
		return { kind: "reconcile", start, base };
	}
	const recorded = parseChange(issue.body).header.branch;
	if (recorded !== undefined) return { kind: "refused", message: `#${n} already records Branch: ${untrusted(recorded)}; switch to that branch instead.` };
	return { kind: "create", start };
}

// --- createBranch --------------------------------------------------------------

type Created = { base: string; previous: string };

/** Fetches the integration branch, creates the change branch at its head and stores the base in git config. */
async function createBranch(git: Git, integration: string, branch: string): Promise<Created> {
	const previous = await git.branch();
	await git.fetch(REMOTE, integration);
	const base = await git.revParse(`${REMOTE}/${integration}`);
	await git.switchCreate(branch, base);
	try {
		await git.configSet(livespecBaseKey(branch), base);
	} catch (error) {
		await rollback(git, branch, previous);
		throw error;
	}
	return { base, previous };
}

async function rollback(git: Git, branch: string, previous: string): Promise<void> {
	await git.switchTo(previous);
	await git.deleteBranch(branch);
}

// --- recordStart ---------------------------------------------------------------

type WriteOutcome = { kind: "written" } | { kind: "conflict"; changed: string[] } | { kind: "thrown"; error: unknown };

function startBody(body: string, branch: string, base: string): string {
	return setHeaderLine(setHeaderLine(body, BASE_KEY, base), BRANCH_KEY, branch);
}

/** Writes `Base:` and `Branch:` with the version that was read; a thrown error is returned, not raised. */
async function recordStart(forge: CachedForge, issue: Issue, branch: string, base: string): Promise<WriteOutcome> {
	try {
		const r = await forge.updateIssueBody(issue.number, startBody(issue.body, branch, base), issue.version);
		return r.status === "written" ? { kind: "written" } : { kind: "conflict", changed: r.changed };
	} catch (error) {
		return { kind: "thrown", error };
	}
}

/** Whether a fresh read of the issue records exactly `branch` and `base`; a stale or failed read cannot confirm it. */
async function recordedOnForge(forge: CachedForge, n: number, branch: string, base: string): Promise<boolean> {
	try {
		const issue = await forge.getIssue(n);
		if (issue.stale) return false;
		const header = parseChange(issue.body).header;
		return header.branch === branch && header.base === base;
	} catch {
		// Re-read failed: the outcome stays unknown and the caller keeps the branch.
		return false;
	}
}

// --- handleWriteFailure --------------------------------------------------------

/**
 * A conflict is a definite rejection: a created branch is rolled back. A thrown error is an unknown
 * outcome: the issue is re-read, and the start succeeds only if it records the written values.
 */
async function handleWriteFailure(
	w: WriteContext,
	start: Started,
	base: string,
	outcome: Exclude<WriteOutcome, { kind: "written" }>,
	created: Created | undefined,
): Promise<Result | undefined> {
	const n = start.issue.number;
	if (outcome.kind === "conflict") {
		const changed = outcome.changed.join(", ") || "unknown fields";
		if (!created) return refuse(`Version conflict on #${n} (${changed}); nothing was written. The branch is kept; rerun change_start #${n}.`);
		try {
			await rollback(w.session.git, start.branch, created.previous);
		} catch (error) {
			return refuse(`Version conflict on #${n} (${changed}); rolling back ${start.branch} failed: ${untrusted(messageOf(error))}`);
		}
		return refuse(`Version conflict on #${n} (${changed}); nothing was written, ${start.branch} was deleted and ${created.previous} checked out again. Rerun change_start #${n}.`);
	}
	if (await recordedOnForge(w.forge, n, start.branch, base)) return undefined;
	return refuse(`Writing Branch and Base to #${n} failed with an unknown outcome (${untrusted(messageOf(outcome.error))}). ${rerunHint(n)}`);
}

/** Writes the start and settles any failure; undefined means the issue records the start. */
async function writeStart(w: WriteContext, start: Started, base: string, created: Created | undefined): Promise<Result | undefined> {
	const outcome = await recordStart(w.forge, start.issue, start.branch, base);
	if (outcome.kind === "written") return undefined;
	return handleWriteFailure(w, start, base, outcome, created);
}

// --- reconcileStart ------------------------------------------------------------

/** A rerun over an existing branch with `livespecBase`: same record → switch; no record → write; else refuse. */
async function reconcileStart(w: WriteContext, start: Started, base: string): Promise<Result> {
	const n = start.issue.number;
	const header = parseChange(start.issue.body).header;
	if (header.branch !== undefined && (header.branch !== start.branch || header.base !== base)) {
		return refuse(
			`#${n} records Branch: ${untrusted(header.branch)} and Base: ${header.base === undefined ? "(none)" : untrusted(header.base)}, but the local ${start.branch} has ${livespecBaseKey(start.branch)} = ${base}. Nothing was changed; the branch is kept. Fix the issue or the branch, then rerun.`,
		);
	}
	await w.session.git.switchTo(start.branch);
	if (header.branch === undefined) {
		const failed = await writeStart(w, start, base, undefined);
		if (failed) return failed;
		await afterForgeWrite(w.session, n);
	} else {
		await w.session.refresh();
	}
	return success(`Reconciled #${n}: on ${start.branch} at Base ${base}.`, start.branch, base, true);
}

// --- tool ----------------------------------------------------------------------

async function createStart(w: WriteContext, start: Started): Promise<Result> {
	const project = w.session.config.project;
	const integration = project ? await integrationBranch(project, w.session.git) : undefined;
	if (integration === undefined) {
		return refuse("The integration branch is unknown: origin/HEAD is not set. Set integrationBranch in .pi/livespec/config.yaml.");
	}
	const created = await createBranch(w.session.git, integration, start.branch);
	const failed = await writeStart(w, start, created.base, created);
	if (failed) return failed;
	await afterForgeWrite(w.session, start.issue.number);
	return success(`Started #${start.issue.number}: on ${start.branch} at ${REMOTE}/${integration} ${created.base}. Nothing was pushed.`, start.branch, created.base, false);
}

export async function runChangeStart(p: ChangeStartParams): Promise<Result> {
	const w = await prepareWrite();
	if (!w.ok) return refuse(w.message);
	const plan = await validateStart(w, p.issue);
	if (plan.kind === "refused") return refuse(plan.message);
	if (plan.kind === "reconcile") return reconcileStart(w, plan.start, plan.base);
	return createStart(w, plan.start);
}

export function registerChangeStart(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: "change_start",
		label: "Start livespec change",
		description:
			"Start an open livespec change: fetch the integration branch from origin, create and switch to livespec/<name> at its head, and record Branch and Base in the issue. Never pushes. Rerun to reconcile after a failed write.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: {
			type: "object",
			properties: { issue: { type: "integer", description: "Number of the change issue" } },
			required: ["issue"],
		} as never,
		execute: (_id, params) => runChangeStart(params as ChangeStartParams),
	});
}
