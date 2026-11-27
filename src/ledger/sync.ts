// Sync of `refs/livespec/<n>` with origin: fetch, fast-forward or replay, fast-forward-only push.
// The only module allowed to call the guarded ledger git paths.

import type { GitExec } from "../engine/git-exec.ts";
import { GitError } from "../engine/git.ts";
import { ledgerDelete, ledgerFetch, ledgerPush } from "../guard/push.ts";
import { LedgerError } from "./entry.ts";
import { deleteRef, hasOrigin, isAncestor, readRef, setRef, swapRef, trackingRef } from "./refs.ts";
import { planReplay } from "./replay.ts";
import { commitEntries, ledgerRef, readTree } from "./store.ts";

export type SyncResult = { status: "synced" } | { status: "pending"; reason: string } | { status: "error"; message: string };
export type FetchState = "fetched" | "stale-known" | "unknown-offline";
export type RemoveResult = { remote: "deleted" | "gone" | "moved" | "failed"; message?: string };

const PUSH_RESTARTS = 3;
const CAS_RETRIES = 5;

/** The remote tip after a fetch (undefined when origin has no ledger), or why origin could not be read. */
type FetchOutcome = { ok: true; remoteTip: string | undefined } | { ok: false; reason: string };

/** Fetch, fast-forward or replay, then push without force; never throws. */
export async function syncLedger(exec: GitExec, root: string, n: number): Promise<SyncResult> {
	try {
		for (let restart = 0; restart <= PUSH_RESTARTS; restart++) {
			const fetched = await fetchRemote(exec, root, n);
			if (!fetched.ok) return { status: "pending", reason: fetched.reason };
			const local = await integrate(exec, root, n, fetched.remoteTip);
			if (local === undefined || local === fetched.remoteTip) return { status: "synced" };
			const pushed = await pushLocal(exec, root, n, local);
			if (pushed !== "rejected") return pushed;
		}
		return { status: "pending", reason: `origin kept moving refs/livespec/${n}; push rejected ${PUSH_RESTARTS + 1} times` };
	} catch (error) {
		return { status: "error", message: messageOf(error) };
	}
}

/** The fetch, fast-forward and replay steps of a sync, without the push; true on success. */
export async function fetchLedger(exec: GitExec, root: string, n: number): Promise<boolean> {
	try {
		const fetched = await fetchRemote(exec, root, n);
		if (fetched.ok) await integrate(exec, root, n, fetched.remoteTip);
		return fetched.ok || fetched.reason === NO_ORIGIN;
	} catch {
		return false;
	}
}

/** True when the clone holds a local or remote-tracking ledger of change `n`. */
export async function hasKnownLedger(exec: GitExec, root: string, n: number): Promise<boolean> {
	return (await readRef(exec, root, ledgerRef(n))) !== undefined || (await readRef(exec, root, trackingRef(n))) !== undefined;
}

/** True when the local tip exists and is neither the tracking ref nor one of its ancestors; local refs only. */
export async function isPending(exec: GitExec, root: string, n: number): Promise<boolean> {
	const local = await readRef(exec, root, ledgerRef(n));
	if (local === undefined) return false;
	const tracking = await readRef(exec, root, trackingRef(n));
	if (tracking === undefined) return true;
	return local !== tracking && !(await isAncestor(exec, root, local, tracking));
}

/** Syncs, deletes the ledger on origin under a lease on the synced tip, then the local refs; never throws. */
export async function removeRemote(exec: GitExec, root: string, n: number): Promise<RemoveResult> {
	let result: RemoveResult;
	try {
		result = await deleteOnOrigin(exec, root, n);
	} catch (error) {
		result = { remote: "failed", message: messageOf(error) };
	}
	try {
		await deleteRef(exec, root, ledgerRef(n));
		await deleteRef(exec, root, trackingRef(n));
	} catch (error) {
		const local = `local refs not deleted: ${messageOf(error)}`;
		return { ...result, message: result.message ? `${result.message}; ${local}` : local };
	}
	return result;
}

const NO_ORIGIN = "the clone has no `origin` remote";

async function deleteOnOrigin(exec: GitExec, root: string, n: number): Promise<RemoveResult> {
	if (!(await hasOrigin(exec, root))) return { remote: "gone" };
	const synced = await syncLedger(exec, root, n);
	if (synced.status === "pending") return { remote: "failed", message: synced.reason };
	if (synced.status === "error") return { remote: "failed", message: synced.message };
	const tip = await readRef(exec, root, ledgerRef(n));
	if (tip === undefined) return { remote: "gone" };
	return { remote: await ledgerDelete(exec, root, n, tip) };
}

/** Fetches origin's ledger into the tracking ref, clearing the tracking ref when origin has none. */
async function fetchRemote(exec: GitExec, root: string, n: number): Promise<FetchOutcome> {
	if (!(await hasOrigin(exec, root))) return { ok: false, reason: NO_ORIGIN };
	let outcome: "fetched" | "absent";
	try {
		outcome = await ledgerFetch(exec, root, n);
	} catch (error) {
		if (error instanceof GitError) return { ok: false, reason: `origin could not be reached: ${error.stderr.trim() || error.message}` };
		throw error;
	}
	const tracking = trackingRef(n);
	if (outcome === "absent") {
		await deleteRef(exec, root, tracking);
		return { ok: true, remoteTip: undefined };
	}
	return { ok: true, remoteTip: await readRef(exec, root, tracking) };
}

/**
 * Brings the local ref onto `remoteTip` (fast-forward, or replay when diverged) and returns the local
 * tip afterwards. A lost compare-and-swap re-reads the local ref and tries again.
 */
async function integrate(exec: GitExec, root: string, n: number, remoteTip: string | undefined): Promise<string | undefined> {
	const ref = ledgerRef(n);
	for (let attempt = 0; attempt <= CAS_RETRIES; attempt++) {
		const local = await readRef(exec, root, ref);
		if (remoteTip === undefined || local === remoteTip) return local;
		if (local !== undefined && (await isAncestor(exec, root, remoteTip, local))) return local;
		const next = await integratedTip(exec, root, n, local, remoteTip);
		if (await swapRef(exec, root, ref, next, local)) return next;
	}
	throw new LedgerError("cas", `another writer kept moving ${ref} during sync; gave up after ${CAS_RETRIES} retries`);
}

/** The commit the local ref should move to: the remote tip itself, or a replay of local-only entries onto it. */
async function integratedTip(exec: GitExec, root: string, n: number, local: string | undefined, remoteTip: string): Promise<string> {
	if (local === undefined || (await isAncestor(exec, root, local, remoteTip))) return remoteTip;
	const replayed = planReplay(await readTree(exec, root, local, n), await readTree(exec, root, remoteTip, n));
	return replayed.length === 0 ? remoteTip : commitEntries(exec, root, n, remoteTip, replayed);
}

/** Pushes `local` without force; on success the tracking ref follows it. */
async function pushLocal(exec: GitExec, root: string, n: number, local: string): Promise<SyncResult | "rejected"> {
	let outcome: "pushed" | "rejected";
	try {
		outcome = await ledgerPush(exec, root, n, local);
	} catch (error) {
		if (error instanceof GitError) return { status: "pending", reason: `push to origin failed: ${error.stderr.trim() || error.message}` };
		throw error;
	}
	if (outcome === "rejected") return outcome;
	await setRef(exec, root, trackingRef(n), local);
	return { status: "synced" };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
