// Audit suggestions (drift-audit "Audit suggestions", design D11): manual commits on the
// integration branch under a capability's `paths`, closed initiatives, and the state an
// audit leaves behind. The rules are pure over the given git and forge; the `…AndSave` wrappers
// at the end read and write `audit.json` through `state.ts`.

import type { AuditOutcome } from "../commands/audit.ts";
import { matchGlob } from "../core/glob.ts";
import type { ProjectConfig } from "../config.ts";
import { type Git, integrationBranch } from "../engine/git.ts";
import type { Forge } from "../forge/types.ts";
import { pullRequestOf } from "./items.ts";
import { capabilityPaths } from "./living-specs.ts";
import { repoViewAt } from "./repo-view.ts";
import { type AuditState, type PendingAudit, readAuditState, writeAuditState } from "./state.ts";

export type ScanDeps = {
	git: Pick<Git, "remoteRef" | "firstParentCommits" | "commitPaths">;
	forge?: Pick<Forge, "getPullRequest">;
	integration: string;
	specs: { capability: string; paths: string[] }[];
};

/** Commits checked per scan; a longer backlog is worked off one batch per session. */
const BATCH = 50;
const LIVESPEC_HEADS = ["livespec/", "fix/"];
const SHORT_SHA = 7;

/**
 * Checks the oldest BATCH first-parent commits of `<cursor>..origin/<integration>` (read without a fetch) and
 * suggests each one that touches a capability's `paths` and did not come through livespec, moving the cursor to the
 * last one checked. The first run only sets the cursor. Without a forge, or on a forge error, the state is unchanged.
 */
export async function scanCommits(deps: ScanDeps, s: AuditState): Promise<AuditState> {
	const tip = await deps.git.remoteRef(`origin/${deps.integration}`);
	if (tip === undefined) return s;
	if (s.cursor === undefined) return { ...s, cursor: tip };
	const forge = deps.forge;
	if (forge === undefined) return s;
	const batch = (await deps.git.firstParentCommits(tip, { after: s.cursor })).slice(0, BATCH);
	const last = batch.at(-1);
	if (last === undefined) return s;
	let found: PendingAudit[];
	try {
		found = await manualCommits(deps, forge, batch);
	} catch {
		return s;
	}
	const known = new Set(s.pending.flatMap((p) => (p.kind === "commit" ? [p.sha] : [])));
	return { ...s, cursor: last.sha, pending: [...s.pending, ...found.filter((p) => p.kind === "commit" && !known.has(p.sha))] };
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

/**
 * The state after a completed audit: commit suggestions contained in the audited commit and the initiative it posted
 * on are cleared, the audited commit is recorded, and the fix cursor moves only when the `declared-none` detector ran
 * to the end. A commit whose ancestry cannot be read stays pending.
 */
export async function completeAudit(
	s: AuditState,
	o: Extract<AuditOutcome, { ok: true }>,
	isAncestor: (a: string, b: string) => Promise<boolean>,
): Promise<AuditState> {
	const pending: PendingAudit[] = [];
	for (const p of s.pending) {
		if (p.kind === "initiative" ? p.initiative === o.posted : await isAncestor(p.sha, o.commit).catch(() => false)) continue;
		pending.push(p);
	}
	return { ...s, ...(o.fixesRan ? { fixCursor: o.commit } : {}), auditedCommit: o.commit, pending };
}

type Store = Pick<Git, "commonDir">;

export type StartDeps = { git: Git; forge?: Pick<Forge, "getPullRequest">; project: ProjectConfig };

/**
 * Session start: the stored state, then a scan with the living specs of `origin/<integration>`, stored when it
 * changed. Never throws: a failure returns the state read so far with the error, for the session to record.
 */
export async function suggestAtStart(d: StartDeps): Promise<{ state: AuditState; error?: unknown }> {
	let state: AuditState = { pending: [] };
	try {
		state = await readAuditState(d.git);
		const integration = await integrationBranch(d.project, d.git);
		const tip = integration === undefined ? undefined : await d.git.remoteRef(`origin/${integration}`);
		if (integration === undefined || tip === undefined) return { state };
		const specs = await capabilityPaths(await repoViewAt(d.git, tip));
		const next = await scanCommits({ git: d.git, ...(d.forge === undefined ? {} : { forge: d.forge }), integration, specs }, state);
		if (next !== state) await writeAuditState(d.git, next);
		return { state: next };
	} catch (error) {
		return { state, error };
	}
}

/** `livespec:initiative-closed`: adds the initiative to the stored state. */
export async function initiativeAndSave(git: Store, n: number): Promise<AuditState> {
	const s = await readAuditState(git);
	const next = addInitiative(s, n);
	if (next !== s) await writeAuditState(git, next);
	return next;
}

/** After a completed audit: applies it to the latest stored state (a suggestion added meanwhile is kept) and stores it. */
export async function auditAndSave(git: Store & Pick<Git, "isAncestor">, o: Extract<AuditOutcome, { ok: true }>): Promise<AuditState> {
	const next = await completeAudit(await readAuditState(git), o, (a, b) => git.isAncestor(a, b));
	await writeAuditState(git, next);
	return next;
}

/** The card reasons of the pending suggestions, in the order they were added. */
export function pendingReasons(s: AuditState): string[] {
	return s.pending.map((p) =>
		p.kind === "initiative" ? `initiative #${p.initiative} closed` : `commit ${p.sha.slice(0, SHORT_SHA)} touches ${p.capabilities.join(", ")}`,
	);
}
