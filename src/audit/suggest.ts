// Audit suggestions (drift-audit "Audit suggestions", design D11): manual commits on the
// integration branch under a capability's `paths`, closed initiatives, and the state an
// audit leaves behind. The rules are pure over the given git and forge; the wrappers at the
// end compute the slow facts first, then apply them to `audit.json` under its lock (`state.ts`).

import type { AuditOutcome } from "../commands/audit.ts";
import { matchGlob } from "../core/glob.ts";
import type { ProjectConfig } from "../config.ts";
import { type Git, integrationBranch } from "../engine/git.ts";
import type { Forge } from "../forge/types.ts";
import { pullRequestOf } from "./items.ts";
import { capabilityPaths } from "./living-specs.ts";
import { repoViewAt } from "./repo-view.ts";
import { type AuditState, type PendingAudit, readAuditState, updateAuditState } from "./state.ts";

/** `tip` is the one `origin/<integration>` commit both the specs and the history are read at. */
export type ScanDeps = {
	git: Pick<Git, "firstParentCommits" | "commitPaths">;
	forge?: Pick<Forge, "getPullRequest">;
	tip: string;
	specs: { capability: string; paths: string[] }[];
};

/** A scan's state; on an error the state is the one given, with the error for the session to record. */
export type ScanResult = { state: AuditState; error?: unknown };

/** Commits checked per scan; a longer backlog is worked off one batch per session. */
const BATCH = 50;
const LIVESPEC_HEADS = ["livespec/", "fix/"];
const SHORT_SHA = 7;

/**
 * Checks the oldest BATCH first-parent commits of `<cursor>..<tip>` and suggests each one that touches a capability's
 * `paths` and did not come through livespec, moving the cursor to the last one checked. The first run only sets the
 * cursor. Without a forge the state is unchanged; on a git or forge error it is unchanged and the error is returned.
 */
export async function scanCommits(deps: ScanDeps, s: AuditState): Promise<ScanResult> {
	if (s.cursor === undefined) return { state: { ...s, cursor: deps.tip } };
	const forge = deps.forge;
	if (forge === undefined) return { state: s };
	try {
		const batch = (await deps.git.firstParentCommits(deps.tip, { after: s.cursor })).slice(0, BATCH);
		const last = batch.at(-1);
		if (last === undefined) return { state: s };
		return { state: withCommits({ ...s, cursor: last.sha }, await manualCommits(deps, forge, batch)) };
	} catch (error) {
		return { state: s, error };
	}
}

/** Adds the commit suggestions not already pending. */
function withCommits(s: AuditState, found: PendingAudit[]): AuditState {
	const known = new Set(s.pending.flatMap((p) => (p.kind === "commit" ? [p.sha] : [])));
	const added = found.filter((p) => p.kind === "commit" && !known.has(p.sha));
	return added.length === 0 ? s : { ...s, pending: [...s.pending, ...added] };
}

/**
 * Applies a scan of `before` to the latest stored state: the cursor moves and the new commit suggestions are added,
 * keeping whatever was stored meanwhile. When another session moved the cursor first, its scan stands. A new commit
 * the stored audited commit contains is dropped, since an audit that completed during the scan covered it.
 */
async function mergeScan(latest: AuditState, before: AuditState, after: AuditState, isAncestor: IsAncestor): Promise<AuditState> {
	if (latest.cursor !== before.cursor || after.cursor === before.cursor) return latest;
	const scanned = { ...latest, ...(after.cursor === undefined ? {} : { cursor: after.cursor }) };
	// Only what the scan itself found: its copy of the old pending list may hold suggestions an audit cleared since.
	const seen = new Set(before.pending.flatMap((p) => (p.kind === "commit" ? [p.sha] : [])));
	const found = after.pending.filter((p) => p.kind === "commit" && !seen.has(p.sha));
	const audited = latest.auditedCommit;
	const covered = audited === undefined ? new Set<string>() : await coveredBy(found, audited, isAncestor);
	return withCommits(scanned, found.filter((p) => p.kind === "commit" && !covered.has(p.sha)));
}

/** The suggestions of a batch; a forge read error propagates so the caller keeps the cursor. */
async function manualCommits(deps: ScanDeps, forge: Pick<Forge, "getPullRequest">, batch: { sha: string; subject: string }[]): Promise<PendingAudit[]> {
	const isLivespec = livespecLookup(forge);
	const found: PendingAudit[] = [];
	for (const commit of batch) {
		const capabilities = touched(deps.specs, await deps.git.commitPaths(commit.sha));
		if (capabilities.length === 0 || (await isLivespec(commit.subject))) continue;
		found.push({ kind: "commit", sha: commit.sha, capabilities });
	}
	return found;
}

/** Whether a subject names a pull request whose head is a livespec branch; one forge read per number. */
function livespecLookup(forge: Pick<Forge, "getPullRequest">): (subject: string) => Promise<boolean> {
	const heads = new Map<number, Promise<string>>();
	return async (subject) => {
		const n = pullRequestOf(subject);
		if (n === undefined) return false;
		let head = heads.get(n);
		if (head === undefined) {
			head = forge.getPullRequest(n).then((pr) => pr.head);
			heads.set(n, head);
		}
		const name = await head;
		return LIVESPEC_HEADS.some((prefix) => name.startsWith(prefix));
	};
}

/** The capabilities, sorted, whose `paths` match one of the files. */
function touched(specs: ScanDeps["specs"], files: string[]): string[] {
	return specs
		.filter((s) => files.some((f) => s.paths.some((p) => matchGlob(p, f))))
		.map((s) => s.capability)
		.sort();
}

/** Adds an initiative suggestion once. */
export function addInitiative(s: AuditState, n: number): AuditState {
	if (s.pending.some((p) => p.kind === "initiative" && p.initiative === n)) return s;
	return { ...s, pending: [...s.pending, { kind: "initiative", initiative: n }] };
}

type Completed = Extract<AuditOutcome, { ok: true }>;
type IsAncestor = (a: string, b: string) => Promise<boolean>;

/**
 * The state after a completed audit: commit suggestions contained in the audited commit and the initiative it posted
 * on are cleared, the audited commit is recorded, and the fix cursor moves only when the `declared-none` detector ran
 * to the end. A commit whose ancestry cannot be read stays pending.
 */
export async function completeAudit(s: AuditState, o: Completed, isAncestor: IsAncestor): Promise<AuditState> {
	const covered = await coveredBy(s.pending, o.commit, isAncestor);
	const pending = s.pending.filter((p) => (p.kind === "initiative" ? p.initiative !== o.posted : !covered.has(p.sha)));
	return { ...s, ...(o.fixesRan ? { fixCursor: o.commit } : {}), auditedCommit: o.commit, pending };
}

/** The commit suggestions `commit` contains; one whose ancestry cannot be read is not covered. */
async function coveredBy(pending: PendingAudit[], commit: string, isAncestor: IsAncestor): Promise<Set<string>> {
	const covered = new Set<string>();
	for (const p of pending) {
		if (p.kind === "commit" && (await isAncestor(p.sha, commit).catch(() => false))) covered.add(p.sha);
	}
	return covered;
}

type Store = Pick<Git, "commonDir">;

export type StartDeps = { git: Git; forge?: Pick<Forge, "getPullRequest">; project: ProjectConfig };

/**
 * Session start: a scan of the stored state against one `origin/<integration>` commit (specs and history both read at
 * it), then merged into the state stored meanwhile, under the lock (with the ancestry reads against the audited commit). Never throws: a failure returns the state read so
 * far with the error, for the session to record; a scan error still stores nothing.
 */
export async function suggestAtStart(d: StartDeps): Promise<ScanResult> {
	let state: AuditState = { pending: [] };
	try {
		state = await readAuditState(d.git);
		const integration = await integrationBranch(d.project, d.git);
		const tip = integration === undefined ? undefined : await d.git.remoteRef(`origin/${integration}`);
		if (tip === undefined) return { state };
		const specs = await capabilityPaths(await repoViewAt(d.git, tip));
		const scan = await scanCommits({ git: d.git, ...(d.forge === undefined ? {} : { forge: d.forge }), tip, specs }, state);
		if (scan.error !== undefined || scan.state === state) return scan;
		const before = state;
		const isAncestor: IsAncestor = (a, b) => d.git.isAncestor(a, b);
		return { state: await updateAuditState(d.git, (latest) => mergeScan(latest, before, scan.state, isAncestor)) };
	} catch (error) {
		return { state, error };
	}
}

/** `livespec:initiative-closed`: adds the initiative to the stored state. */
export function initiativeAndSave(git: Store, n: number): Promise<AuditState> {
	return updateAuditState(git, (s) => addInitiative(s, n));
}

/**
 * After a completed audit: applied to the latest stored state under the lock, with the ancestry read there, so every
 * suggestion stored meanwhile is checked against the audited commit and the others are kept.
 */
export function auditAndSave(git: Store & Pick<Git, "isAncestor">, o: Completed): Promise<AuditState> {
	return updateAuditState(git, (latest) => completeAudit(latest, o, (a, b) => git.isAncestor(a, b)));
}

/** The card reasons of the pending suggestions, in the order they were added. */
export function pendingReasons(s: AuditState): string[] {
	return s.pending.map((p) =>
		p.kind === "initiative" ? `initiative #${p.initiative} closed` : `commit ${p.sha.slice(0, SHORT_SHA)} touches ${p.capabilities.join(", ")}`,
	);
}
