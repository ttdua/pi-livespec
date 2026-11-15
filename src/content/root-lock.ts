// Exclusive cross-process lock on the shared agent-skills root. `mkdir` of
// `<root>/.lock` is atomic, so EEXIST means another process holds it.
// `owner.json` records the holder; a lock older than STALE_LOCK_MS is taken over.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LOCK_DIR = ".lock";
export const OWNER_FILE = "owner.json";
/** A holder older than this is presumed dead (crashed session) and its lock is taken over. */
export const STALE_LOCK_MS = 10 * 60 * 1000;
/** How long manual commands wait for the lock before reporting busy. */
export const MANUAL_LOCK_TIMEOUT_MS = 30 * 1000;
export const LOCK_RETRY_MS = 100;

const TOKEN_BYTES = 8;
const REAP_SUFFIX = ".reap";

export type RootLockOptions = { timeoutMs?: number; retryMs?: number; staleMs?: number; now?: () => number };
/** `try` never waits; `wait` retries until `timeoutMs`. */
export type RootLockMode = "try" | "wait";
export type LockOwner = { pid: number; acquiredAt: string; token: string };
export type Locked<T> = { acquired: true; value: T } | { acquired: false };

/** Runs `fn` while holding the root lock; `{ acquired: false }` when it could not be taken. Always released. */
export async function withRootLock<T>(root: string, mode: RootLockMode, fn: () => Promise<T>, opts: RootLockOptions = {}): Promise<Locked<T>> {
	const now = opts.now ?? Date.now;
	const deadline = now() + (mode === "wait" ? (opts.timeoutMs ?? MANUAL_LOCK_TIMEOUT_MS) : 0);
	await mkdir(root, { recursive: true });
	const dir = join(root, LOCK_DIR);
	for (;;) {
		const token = await tryAcquire(dir, now);
		if (token !== undefined) {
			try {
				return { acquired: true, value: await fn() };
			} finally {
				await release(dir, token);
			}
		}
		if (await takeOverIfStale(dir, now, opts.staleMs ?? STALE_LOCK_MS)) continue;
		if (now() >= deadline) return { acquired: false };
		await sleep(opts.retryMs ?? LOCK_RETRY_MS);
	}
}

/** The holder token when `mkdir` wins; `undefined` when the lock is held. */
async function tryAcquire(dir: string, now: () => number): Promise<string | undefined> {
	if (!(await tryMkdir(dir))) return undefined;
	const owner: LockOwner = { pid: process.pid, acquiredAt: new Date(now()).toISOString(), token: randomBytes(TOKEN_BYTES).toString("hex") };
	await writeFile(join(dir, OWNER_FILE), JSON.stringify(owner), "utf8");
	return owner.token;
}

/** Removes the lock only if it is still ours (a stale takeover may have replaced it). */
async function release(dir: string, token: string): Promise<void> {
	const owner = await readOwner(dir);
	if (owner?.token === token) await rm(dir, { recursive: true, force: true });
}

/**
 * Takes over a lock whose `acquiredAt` (or, without a readable owner, the directory mtime) is older than `staleMs`.
 * Takeovers are serialised by a second `mkdir` lock (`.lock.reap`), and staleness is re-checked while holding it:
 * otherwise two contenders that both saw the stale lock could remove a fresh lock that one of them just took.
 */
async function takeOverIfStale(dir: string, now: () => number, staleMs: number): Promise<boolean> {
	const since = await heldSince(dir);
	if (since === undefined) return true; // released between mkdir and here: retry at once
	if (now() - since <= staleMs) return false;
	const reap = `${dir}${REAP_SUFFIX}`;
	if (!(await tryMkdir(reap))) {
		await clearStaleReaper(reap, now, staleMs);
		return false;
	}
	try {
		const recheck = await heldSince(dir);
		if (recheck === undefined) return true;
		if (now() - recheck <= staleMs) return false;
		const aside = `${dir}.stale-${process.pid}-${randomBytes(TOKEN_BYTES).toString("hex")}`;
		await rename(dir, aside);
		await rm(aside, { recursive: true, force: true });
		return true;
	} finally {
		await rm(reap, { recursive: true, force: true });
	}
}

/** A reaper that crashed mid-takeover leaves `.lock.reap` behind; remove it once it is itself stale. */
async function clearStaleReaper(reap: string, now: () => number, staleMs: number): Promise<void> {
	const since = await mtimeOf(reap);
	if (since !== undefined && now() - since > staleMs) await rm(reap, { recursive: true, force: true });
}

async function tryMkdir(path: string): Promise<boolean> {
	try {
		await mkdir(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

async function mtimeOf(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function heldSince(dir: string): Promise<number | undefined> {
	const owner = await readOwner(dir);
	const at = owner ? Date.parse(owner.acquiredAt) : Number.NaN;
	return Number.isNaN(at) ? mtimeOf(dir) : at;
}

/** `undefined` when the owner file is absent (not yet written) or unreadable as JSON. */
async function readOwner(dir: string): Promise<LockOwner | undefined> {
	let text: string;
	try {
		text = await readFile(join(dir, OWNER_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const value = JSON.parse(text) as Partial<LockOwner>;
		return typeof value.acquiredAt === "string" && typeof value.token === "string" ? (value as LockOwner) : undefined;
	} catch {
		// A torn or foreign owner file: treat as unknown and fall back to the directory mtime.
		return undefined;
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
