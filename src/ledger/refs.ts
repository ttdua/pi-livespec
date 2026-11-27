// Local ref plumbing for the ledger: reads, compare-and-swap moves, deletes and ancestry,
// all against the local repository only (no network).

import type { GitExec } from "../engine/git-exec.ts";
import { LedgerError } from "./entry.ts";
import { ledgerRef } from "./store.ts";

/** `update-ref` old value that requires the ref not to exist yet. */
const ABSENT = "";
/** `git remote get-url` exit code for a remote that is not configured. */
const NO_SUCH_REMOTE = 2;

/** The remote-tracking copy of the ledger of change `n`. */
export function trackingRef(n: number): string {
	ledgerRef(n);
	return `refs/livespec-origin/${n}`;
}

/** The commit `ref` points at, or undefined when it does not exist. */
export async function readRef(exec: GitExec, root: string, ref: string): Promise<string | undefined> {
	const r = await exec(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root });
	if (r.code === 0) return r.stdout.trim();
	if (r.code === 1 && r.stderr.trim() === "") return undefined;
	throw failure(["rev-parse", ref], r.spawnError ?? r.stderr);
}

/** Moves `ref` to `next` if it is still at `expected` (absent when undefined); false when another writer moved it. */
export async function swapRef(exec: GitExec, root: string, ref: string, next: string, expected: string | undefined): Promise<boolean> {
	const r = await exec(["update-ref", "-m", "livespec: sync", ref, next, expected ?? ABSENT], { cwd: root });
	if (r.code === 0) return true;
	if ((await readRef(exec, root, ref)) !== expected) return false;
	throw failure(["update-ref", ref], r.spawnError ?? r.stderr);
}

/** Points `ref` at `sha` unconditionally (used for the tracking ref, which only mirrors origin). */
export async function setRef(exec: GitExec, root: string, ref: string, sha: string): Promise<void> {
	await run(exec, root, ["update-ref", "-m", "livespec: sync", ref, sha]);
}

/** Deletes `ref`; a missing ref is not an error. */
export async function deleteRef(exec: GitExec, root: string, ref: string): Promise<void> {
	await run(exec, root, ["update-ref", "-d", ref]);
}

/** True when `ancestor` is `descendant` or one of its ancestors. */
export async function isAncestor(exec: GitExec, root: string, ancestor: string, descendant: string): Promise<boolean> {
	const args = ["merge-base", "--is-ancestor", ancestor, descendant];
	const r = await exec(args, { cwd: root });
	if (r.code === 0) return true;
	if (r.code === 1) return false;
	throw failure(args, r.spawnError ?? r.stderr);
}

/** True when the repository at `root` has an `origin` remote. */
export async function hasOrigin(exec: GitExec, root: string): Promise<boolean> {
	const args = ["remote", "get-url", "origin"];
	const r = await exec(args, { cwd: root });
	if (r.code === 0) return true;
	if (r.code === NO_SUCH_REMOTE) return false;
	throw failure(args, r.spawnError ?? r.stderr);
}

async function run(exec: GitExec, root: string, args: string[]): Promise<void> {
	const r = await exec(args, { cwd: root });
	if (r.code !== 0) throw failure(args, r.spawnError ?? r.stderr);
}

function failure(args: string[], detail: string): LedgerError {
	return new LedgerError("git", `git ${args.join(" ")} failed: ${detail.trim()}`);
}
