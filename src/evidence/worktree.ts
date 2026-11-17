// A temporary detached worktree at a commit, prepared for `Verify` with
// `verify.setup` or with dependency symlinks, and always removed afterwards.

import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Git } from "../engine/git.ts";
import { type RunOptions, runVerify } from "./runner.ts";

const TEMP_PREFIX = "livespec-verify-";
/** Dependency folders linked from the main worktree when they exist there and are git-ignored. */
const DEPENDENCY_FOLDERS: readonly string[] = ["node_modules", ".venv", "vendor"];

export type WorktreeFailure = { invalid: "setup" | "aborted"; output: string };

type Prep = { setup?: string; run: Omit<RunOptions, "cwd"> };

/**
 * Runs `fn` in a fresh worktree of `root` at `sha`. Stale worktree entries are pruned first;
 * the worktree is removed whatever `fn` does. A failed or blocked setup gives `invalid: "setup"`.
 */
export async function withTempWorktree<T>(
	git: Git,
	root: string,
	sha: string,
	prep: Prep,
	fn: (dir: string) => Promise<T>,
): Promise<T | WorktreeFailure> {
	if (prep.run.signal?.aborted) return { invalid: "aborted", output: "" };
	await git.worktreePrune();
	const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
	try {
		await git.worktreeAdd(dir, sha);
		const failure = await prepare(git, root, dir, prep);
		return failure ?? (await fn(dir));
	} finally {
		await removeWorktree(git, dir);
	}
}

/** Runs `verify.setup` in `dir`, or links the dependency folders when no setup is set. */
async function prepare(git: Git, root: string, dir: string, prep: Prep): Promise<WorktreeFailure | undefined> {
	if (prep.setup === undefined) {
		await linkDependencies(git, root, dir);
		return undefined;
	}
	const result = await runVerify(prep.setup, { ...prep.run, cwd: dir });
	if ("blocked" in result) return { invalid: "setup", output: result.blocked };
	if (result.aborted) return { invalid: "aborted", output: result.output };
	if (result.exit !== 0) return { invalid: "setup", output: result.output };
	return undefined;
}

async function linkDependencies(git: Git, root: string, dir: string): Promise<void> {
	for (const name of DEPENDENCY_FOLDERS) {
		const source = join(root, name);
		const target = join(dir, name);
		if (!existsSync(source) || existsSync(target) || !(await git.isIgnored(name))) continue;
		await symlink(source, target);
	}
}

/** `git worktree remove`, then deletes whatever is left and prunes the entry, so nothing remains. */
async function removeWorktree(git: Git, dir: string): Promise<void> {
	try {
		await git.worktreeRemove(dir);
	} catch {
		// The add may have failed, or the tree is locked; the delete and prune below still clean up.
	}
	await rm(dir, { recursive: true, force: true });
	await git.worktreePrune();
}
