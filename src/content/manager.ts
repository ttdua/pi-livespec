// Entry point for the shared agent-skills clone: first clone, automatic and
// manual upgrades, pin, rollback and status. Each method delegates the policy to
// `decideUpgrade` and the filesystem work to `tree.ts`, `lock.ts` and `skill-diff.ts`.

import type { Channel } from "../config.ts";
import { GitError } from "../engine/git.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { CompatFailure } from "./compat.ts";
import { type Lock, freshLock, readLock, withInstalled, withRolledBack, writeLock } from "./lock.ts";
import type { Mirror } from "./mirror.ts";
import { packSkillNames } from "./pack-skills.ts";
import type { ContentPaths } from "./paths.ts";
import { type SkillChanges, diffSkills, skillDirNames } from "./skill-diff.ts";
import { type TreeResult, hasTree, installTree, pruneTrees, readActiveTree, shaOfTree, switchCurrent } from "./tree.ts";
import { decideUpgrade, upgradeGate, workInProgressReason } from "./upgrade.ts";
import type { WorkInProgress } from "./wip.ts";

export type { SkillChanges } from "./skill-diff.ts";

export type CloneResult =
	| { kind: "exists"; sha: string }
	| { kind: "installed"; sha: string }
	| { kind: "failed"; reason: string; failures?: CompatFailure[] };

export type UpgradeOutcome =
	| { kind: "installed"; sha: string; changed: SkillChanges }
	| { kind: "skipped" | "refused" | "failed"; reason: string; failures?: CompatFailure[] }
	| { kind: "notified"; sha: string };

export type ContentManagerDeps = { paths: ContentPaths; mirror: Mirror; now: () => Date; source: string };

const NOT_CLONED = "agent-skills is not cloned; run /livespec init";
/** `rev-parse --verify --quiet` exits 1 when the ref names no commit. */
const EXIT_UNKNOWN_REF = 1;
const INCOMPATIBLE = "the commit is not compatible with the flow pack";

/** Result of an install: compatible tree, atomic switch, lock, prune. The lock is only written on success. */
type Applied = { ok: true; sha: string; changed: SkillChanges } | { ok: false; reason: string; failures?: CompatFailure[] };

export class ContentManager {
	constructor(private readonly d: ContentManagerDeps) {}

	async clone(pack: Pack): Promise<CloneResult> {
		const active = await this.activeTree();
		if (active !== undefined) return { kind: "exists", sha: shaOfTree(active) };
		const fetched = await this.fetchHead(this.d.source, true);
		if ("reason" in fetched) return { kind: "failed", reason: fetched.reason };
		const previous = (await readLock(this.d.paths.lock)) ?? freshLock(this.d.source);
		const base = { ...previous, source: this.d.source, checkedAt: this.checkedNow() };
		const applied = await this.apply(base, fetched.head, pack);
		return applied.ok ? { kind: "installed", sha: fetched.head } : { kind: "failed", ...failure(applied) };
	}

	async autoCheck(pack: Pack, channel: Channel, wip: WorkInProgress): Promise<UpgradeOutcome> {
		const lock = await readLock(this.d.paths.lock);
		if (!lock) return { kind: "skipped", reason: NOT_CLONED };
		const gate = upgradeGate({ channel, lock, now: this.d.now(), workInProgress: wip, manual: false });
		if (gate) return { kind: "skipped", reason: gate.reason };
		// Every automatic fetch records the check time, whatever follows.
		const checked = { ...lock, checkedAt: this.checkedNow() };
		const fetched = await this.fetchHead(lock.source);
		if ("reason" in fetched) {
			await writeLock(this.d.paths.lock, checked);
			return { kind: "failed", reason: fetched.reason };
		}
		const decision = decideUpgrade({ channel, lock, now: this.d.now(), head: fetched.head, workInProgress: wip, manual: false });
		if (decision.kind !== "install") {
			await writeLock(this.d.paths.lock, checked);
			return decision.kind === "notify" ? { kind: "notified", sha: decision.sha } : { kind: "skipped", reason: decision.reason };
		}
		const applied = await this.apply(checked, decision.sha, pack);
		if (applied.ok) return installed(applied);
		await writeLock(this.d.paths.lock, checked);
		return { kind: "failed", ...failure(applied) };
	}

	/** Fetches and installs now, ignoring the 24-hour limit; refused while pinned or during work in progress. */
	async update(pack: Pack, wip: WorkInProgress): Promise<UpgradeOutcome> {
		const lock = await readLock(this.d.paths.lock);
		if (!lock) return { kind: "refused", reason: NOT_CLONED };
		const manual = { channel: "auto" as const, lock, now: this.d.now(), workInProgress: wip, manual: true };
		const gate = upgradeGate(manual);
		if (gate) return { kind: "refused", reason: gate.reason };
		const fetched = await this.fetchHead(lock.source);
		if ("reason" in fetched) return { kind: "failed", reason: fetched.reason };
		const decision = decideUpgrade({ ...manual, head: fetched.head });
		if (decision.kind === "skip") return { kind: "skipped", reason: decision.reason };
		return this.manualInstall(lock, decision.sha, pack);
	}

	/** Installs commit `ref` and records the pin; refused during work in progress. */
	async pin(ref: string, pack: Pack, wip: WorkInProgress): Promise<UpgradeOutcome> {
		if (wip.busy) return { kind: "refused", reason: workInProgressReason(wip) };
		const lock = await readLock(this.d.paths.lock);
		if (!lock) return { kind: "refused", reason: NOT_CLONED };
		let sha: string | undefined;
		try {
			sha = await this.resolveCommit(ref);
		} catch (error) {
			return { kind: "failed", reason: fetchFailure(lock.source, error) };
		}
		if (sha === undefined) return { kind: "failed", reason: `unknown agent-skills commit \`${ref}\`` };
		return this.manualInstall(lock, sha, pack, sha);
	}

	async unpin(): Promise<void> {
		const lock = await readLock(this.d.paths.lock);
		if (lock && lock.pinned !== null) await writeLock(this.d.paths.lock, { ...lock, pinned: null });
	}

	/** Switches back to the previous history entry and skips the abandoned commit. Allowed during work in progress. */
	async rollback(): Promise<UpgradeOutcome> {
		const lock = await readLock(this.d.paths.lock);
		if (!lock) return { kind: "refused", reason: NOT_CLONED };
		const at = lock.history.lastIndexOf(lock.commit);
		const previous = at > 0 ? lock.history[at - 1] : undefined;
		if (previous === undefined) return { kind: "refused", reason: "no previous agent-skills commit to roll back to" };
		if (!(await hasTree(this.d.paths, previous))) return { kind: "refused", reason: `the tree of ${previous} is missing; run /livespec skills pin ${previous}` };
		const from = this.d.paths.tree(lock.commit);
		const to = this.d.paths.tree(previous);
		await switchCurrent(this.d.paths, previous);
		const next = withRolledBack(lock, previous);
		await writeLock(this.d.paths.lock, next);
		const changed = await diffSkills(from, to, await skillDirNames(from, to));
		await pruneTrees(this.d.paths, next.history);
		return { kind: "installed", sha: previous, changed };
	}

	async status(channel: Channel): Promise<string> {
		const lock = await readLock(this.d.paths.lock);
		if (!lock) return `agent-skills: ${NOT_CLONED}`;
		return [
			`Active commit: ${lock.commit || "none"}`,
			`Pinned: ${lock.pinned ?? "no"}`,
			`Channel: ${channel}`,
			`Last check: ${lock.checkedAt ?? "never"}`,
			`Kept commits: ${lock.history.join(", ") || "none"}`,
		].join("\n");
	}

	activeTree(): Promise<string | undefined> {
		return readActiveTree(this.d.paths);
	}

	private async manualInstall(lock: Lock, sha: string, pack: Pack, pinned?: string): Promise<UpgradeOutcome> {
		const base = pinned === undefined ? lock : { ...lock, pinned };
		const applied = await this.apply(base, sha, pack);
		return applied.ok ? installed(applied) : { kind: "failed", ...failure(applied) };
	}

	private async apply(base: Lock, sha: string, pack: Pack): Promise<Applied> {
		const previous = await this.activeTree();
		let tree: TreeResult;
		try {
			tree = await installTree(this.d.paths, this.d.mirror, sha, pack);
		} catch (error) {
			return { ok: false, reason: `cannot check out agent-skills ${sha}: ${messageOf(error)}` };
		}
		if (!tree.ok) return { ok: false, reason: INCOMPATIBLE, failures: tree.failures };
		await switchCurrent(this.d.paths, sha);
		const lock = withInstalled(base, sha);
		await writeLock(this.d.paths.lock, lock);
		const changed = await diffSkills(previous, tree.tree, packSkillNames(pack));
		await pruneTrees(this.d.paths, lock.history);
		return { ok: true, sha, changed };
	}

	/** A known commit resolves directly; an unknown one after one fetch. `undefined` when still unknown. */
	private async resolveCommit(ref: string): Promise<string | undefined> {
		const known = await this.tryResolve(ref);
		if (known !== undefined) return known;
		await this.d.mirror.fetch();
		return this.tryResolve(ref);
	}

	private async tryResolve(ref: string): Promise<string | undefined> {
		try {
			return await this.d.mirror.resolve(ref);
		} catch (error) {
			if (error instanceof GitError && error.code === EXIT_UNKNOWN_REF) return undefined;
			throw error;
		}
	}

	/** Fetches the upstream head, creating the mirror first when `ensure`; a failure names the source. */
	private async fetchHead(source: string, ensure = false): Promise<{ head: string } | { reason: string }> {
		try {
			if (ensure) await this.d.mirror.ensure(source);
			return { head: await this.d.mirror.fetch() };
		} catch (error) {
			return { reason: fetchFailure(source, error) };
		}
	}

	private checkedNow(): string {
		return this.d.now().toISOString();
	}
}

function installed(a: Extract<Applied, { ok: true }>): UpgradeOutcome {
	return { kind: "installed", sha: a.sha, changed: a.changed };
}

function failure(a: Extract<Applied, { ok: false }>): { reason: string; failures?: CompatFailure[] } {
	return a.failures ? { reason: a.reason, failures: a.failures } : { reason: a.reason };
}

function fetchFailure(source: string, error: unknown): string {
	return `cannot fetch agent-skills from ${source}: ${messageOf(error)}`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
