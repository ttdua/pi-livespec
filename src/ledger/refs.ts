// Local ref plumbing for the ledger: names, reads, compare-and-swap moves, deletes and ancestry,
// all against the local repository only (no network).

import type { GitExec } from "../engine/git-exec.ts";
import { LedgerError } from "./entry.ts";

/** `update-ref` old value that requires the ref not to exist yet. */
export const ABSENT = "";
/** `git remote get-url` exit code for a remote that is not configured. */
const NO_SUCH_REMOTE = 2;
const LOCK_BACKOFF_MS = 20;
const LOST_SWAP = /cannot lock ref|unable to (create|lock)|is at .* but expected|reference already exists/i;

/** The ledger ref of change `n`; throws before any git call when `n` is not a positive integer. */
export function ledgerRef(n: number): string {
	if (!Number.isSafeInteger(n) || n < 1) throw new LedgerError("git", `ledger issue must be a positive integer, got ${n}`);
	return `refs/livespec/${n}`;
}

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
	throw gitFailure(["rev-parse", ref], r.spawnError ?? r.stderr);
}

/** The commits the local and remote-tracking ledger refs point at, read in one git call; non-commits read as absent. */
export async function readLedgerRefs(exec: GitExec, root: string, n: number): Promise<{ local: string | undefined; tracking: string | undefined }> {
	const local = ledgerRef(n);
	const tracking = trackingRef(n);
	const format = "--format=%(refname) %(objecttype) %(objectname) %(*objecttype) %(*objectname)";
	const args = ["for-each-ref", format, local, tracking];
	const r = await exec(args, { cwd: root });
	if (r.code !== 0) throw gitFailure(args, r.spawnError ?? r.stderr);
	const tips = new Map<string, string>();
	for (const line of r.stdout.split("\n")) {
		if (line === "") continue;
		// Refnames hold no spaces; the starred fields are empty unless the ref is an annotated tag.
		const [name = "", type, sha, peeledType, peeledSha] = line.split(" ");
		const commit = type === "commit" ? sha : peeledType === "commit" ? peeledSha : undefined;
		if (commit) tips.set(name, commit);
	}
	// Patterns match path prefixes, so only exact names are looked up.
	return { local: tips.get(local), tracking: tips.get(tracking) };
}

/**
 * True when an `update-ref` of `ref` expecting `expected` failed because another writer moved the ref
 * or held its lock; the caller may retry. Any other failure is a real error.
 */
export async function isLostSwap(exec: GitExec, root: string, ref: string, expected: string | undefined, failure: string): Promise<boolean> {
	if ((await readRef(exec, root, ref)) !== expected) return true;
	return LOST_SWAP.test(failure);
}

/** Moves `ref` to `next` if it is still at `expected` (absent when undefined); false on a lost swap. */
export async function swapRef(exec: GitExec, root: string, ref: string, next: string, expected: string | undefined, message = "livespec: sync"): Promise<boolean> {
	const r = await exec(["update-ref", "-m", message, ref, next, expected ?? ABSENT], { cwd: root });
	if (r.code === 0) return true;
	const failure = r.spawnError ?? r.stderr;
	if (await isLostSwap(exec, root, ref, expected, failure)) return false;
	throw gitFailure(["update-ref", ref], failure);
}

/**
 * Moves `ref` to `next` only forward: a no-op when `ref` already is `next` or descends from it, so
 * concurrent writers never move it back. Gives up quietly after `retries` lost swaps (another writer
 * keeps moving it, which already records an equal or newer tip).
 */
export async function advanceRef(exec: GitExec, root: string, ref: string, next: string, retries: number): Promise<void> {
	for (let attempt = 0; attempt <= retries; attempt++) {
		const current = await readRef(exec, root, ref);
		if (current !== undefined && (current === next || (await isAncestor(exec, root, next, current)))) return;
		if (await swapRef(exec, root, ref, next, current)) return;
	}
}

/** Deletes `ref`; a missing ref is not an error. */
export async function deleteRef(exec: GitExec, root: string, ref: string): Promise<void> {
	const args = ["update-ref", "-d", ref];
	const r = await exec(args, { cwd: root });
	if (r.code !== 0) throw gitFailure(args, r.spawnError ?? r.stderr);
}

/** Deletes `ref` only while it still is at `expected`; true when it is deleted (or already absent), false when it moved, nothing deleted. */
export async function deleteRefIf(exec: GitExec, root: string, ref: string, expected: string): Promise<boolean> {
	const args = ["update-ref", "-d", ref, expected];
	const r = await exec(args, { cwd: root });
	if (r.code === 0) return true;
	const failure = r.spawnError ?? r.stderr;
	if ((await readRef(exec, root, ref)) === undefined) return true;
	if (await isLostSwap(exec, root, ref, expected, failure)) return false;
	throw gitFailure(args, failure);
}

/** Ancestry between immutable commits never changes, so answers are cached per repository and pair. */
const ancestryCache = new Map<string, boolean>();
const ANCESTRY_CACHE_LIMIT = 512;

/** True when `ancestor` is `descendant` or one of its ancestors. */
export async function isAncestor(exec: GitExec, root: string, ancestor: string, descendant: string): Promise<boolean> {
	if (ancestor === descendant) return true;
	const key = `${root}\0${ancestor}\0${descendant}`;
	const known = ancestryCache.get(key);
	if (known !== undefined) return known;
	const answer = await askAncestor(exec, root, ancestor, descendant);
	if (ancestryCache.size >= ANCESTRY_CACHE_LIMIT) ancestryCache.clear();
	ancestryCache.set(key, answer);
	return answer;
}

async function askAncestor(exec: GitExec, root: string, ancestor: string, descendant: string): Promise<boolean> {
	const args = ["merge-base", "--is-ancestor", ancestor, descendant];
	const r = await exec(args, { cwd: root });
	if (r.code === 0) return true;
	if (r.code === 1) return false;
	throw gitFailure(args, r.spawnError ?? r.stderr);
}

/** True when the repository at `root` has an `origin` remote. */
export async function hasOrigin(exec: GitExec, root: string): Promise<boolean> {
	const args = ["remote", "get-url", "origin"];
	const r = await exec(args, { cwd: root });
	if (r.code === 0) return true;
	if (r.code === NO_SUCH_REMOTE) return false;
	throw gitFailure(args, r.spawnError ?? r.stderr);
}

/** Waits a little longer after each lost swap so a writer holding the lock can finish. */
export function backoff(attempt: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, LOCK_BACKOFF_MS * (attempt + 1)));
}

export function gitFailure(args: string[], detail: string): LedgerError {
	return new LedgerError("git", `git ${args.join(" ")} failed: ${detail.trim()}`);
}
