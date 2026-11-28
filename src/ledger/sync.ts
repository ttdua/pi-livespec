// Sync of `refs/livespec/<n>` with origin: fetch, fast-forward or replay, fast-forward-only push.
// The only module allowed to call the guarded ledger git paths.

import type { GitExec } from "../engine/git-exec.ts";
import { GitError } from "../engine/git.ts";
import { ledgerDelete, ledgerFetch, ledgerPush } from "../guard/push.ts";
import { advanceRef, backoff, deleteRef, deleteRefIf, hasOrigin, isAncestor, ledgerRef, readLedgerRefs, readRef, swapRef, trackingRef } from "./refs.ts";
import { planReplay } from "./replay.ts";
import { commitEntries, readTree } from "./store.ts";

export type SyncResult = { status: "synced" } | { status: "pending"; reason: string } | { status: "error"; message: string };
export type FetchState = "fetched" | "stale-known" | "unknown-offline";
export type RemoveResult = { remote: "deleted" | "gone" | "moved" | "failed"; message?: string; localKept?: boolean };

const PUSH_RESTARTS = 3;
/** Restarts from the fetch after a lost local compare-and-swap. */
const SWAP_RESTARTS = 5;
/** Lost swaps tolerated while moving the tracking ref forward. */
const TRACKING_RETRIES = 3;
const NO_ORIGIN = "the clone has no `origin` remote";

/** The remote tip after a fetch (undefined when origin has no ledger), or why origin could not be read. */
type FetchOutcome = { ok: true; remoteTip: string | undefined } | { ok: false; reason: string };
/** The local and remote tips once the local ref holds every remote entry, or why that did not happen. */
type Integrated = { ok: true; local: string | undefined; remoteTip: string | undefined } | { ok: false; reason: string };

/** Fetch, fast-forward or replay, then push without force; never throws. */
export async function syncLedger(exec: GitExec, root: string, n: number): Promise<SyncResult> {
	return (await syncLedgerTip(exec, root, n)).result;
}

/** A sync outcome with the tip both sides held when it succeeded (undefined when no ledger exists). */
export type SyncedTip = { result: SyncResult; tip?: string };

/** Like `syncLedger`, also returning the synced tip: the commit local and origin agreed on. */
export async function syncLedgerTip(exec: GitExec, root: string, n: number): Promise<SyncedTip> {
	try {
		for (let restart = 0; restart <= PUSH_RESTARTS; restart++) {
			const state = await fetchAndIntegrate(exec, root, n);
			if (!state.ok) return { result: { status: "pending", reason: state.reason } };
			const { local, remoteTip } = state;
			if (local === undefined || local === remoteTip) return { result: { status: "synced" }, ...(local === undefined ? {} : { tip: local }) };
			const pushed = await pushLocal(exec, root, n, local);
			if (pushed !== "rejected") return { result: pushed, ...(pushed.status === "synced" ? { tip: local } : {}) };
		}
		return { result: { status: "pending", reason: `origin kept moving refs/livespec/${n}; push rejected ${PUSH_RESTARTS + 1} times` } };
	} catch (error) {
		return { result: { status: "error", message: messageOf(error) } };
	}
}

/** The fetch, fast-forward and replay steps of a sync, without the push; true on success. */
export async function fetchLedger(exec: GitExec, root: string, n: number): Promise<boolean> {
	try {
		const state = await fetchAndIntegrate(exec, root, n);
		return state.ok || state.reason === NO_ORIGIN;
	} catch {
		return false;
	}
}

/** True when the clone holds a local or remote-tracking ledger of change `n`. */
export async function hasKnownLedger(exec: GitExec, root: string, n: number): Promise<boolean> {
	const { local, tracking } = await readLedgerRefs(exec, root, n);
	return local !== undefined || tracking !== undefined;
}

/** True when the local tip exists and is neither the tracking ref nor one of its ancestors; local refs only. */
export async function isPending(exec: GitExec, root: string, n: number): Promise<boolean> {
	const { local, tracking } = await readLedgerRefs(exec, root, n);
	if (local === undefined) return false;
	if (tracking === undefined) return true;
	return local !== tracking && !(await isAncestor(exec, root, local, tracking));
}

/**
 * Syncs, deletes the ledger on origin under a lease on the synced tip, then the local refs by compare-and-swap on
 * that tip; an entry appended since the sync keeps the local ref (`localKept`). Never throws.
 */
export async function removeRemote(exec: GitExec, root: string, n: number): Promise<RemoveResult> {
	let start: string | undefined;
	let result: RemoveResult;
	let tip: string | undefined;
	try {
		start = await readRef(exec, root, ledgerRef(n));
		const deleted = await deleteOnOrigin(exec, root, n, start);
		result = deleted.result;
		tip = deleted.tip;
	} catch (error) {
		result = { remote: "failed", message: messageOf(error) };
		tip = start;
	}
	return deleteLocal(exec, root, n, result, tip);
}

/** Deletes the local ref only while it still is at `tip`, then the tracking ref; reports what stayed. */
async function deleteLocal(exec: GitExec, root: string, n: number, result: RemoveResult, tip: string | undefined): Promise<RemoveResult> {
	try {
		const kept = tip !== undefined && !(await deleteRefIf(exec, root, ledgerRef(n), tip));
		await deleteRef(exec, root, trackingRef(n));
		if (!kept) return result;
		const note = "local ref kept: entries were appended after the sync and are not on origin";
		return { ...result, localKept: true, message: result.message ? `${result.message}; ${note}` : note };
	} catch (error) {
		const local = `local refs not deleted: ${messageOf(error)}`;
		return { ...result, message: result.message ? `${result.message}; ${local}` : local };
	}
}

async function deleteOnOrigin(exec: GitExec, root: string, n: number, start: string | undefined): Promise<{ result: RemoveResult; tip: string | undefined }> {
	if (!(await hasOrigin(exec, root))) return { result: { remote: "gone" }, tip: start };
	const { result: synced, tip } = await syncLedgerTip(exec, root, n);
	if (synced.status === "pending") return { result: { remote: "failed", message: synced.reason }, tip: start };
	if (synced.status === "error") return { result: { remote: "failed", message: synced.message }, tip: start };
	if (tip === undefined) return { result: { remote: "gone" }, tip: undefined };
	return { result: { remote: await ledgerDelete(exec, root, n, tip) }, tip };
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

/** Fetch, then fast-forward or replay; a lost local compare-and-swap restarts from the fetch. */
async function fetchAndIntegrate(exec: GitExec, root: string, n: number): Promise<Integrated> {
	for (let attempt = 0; attempt <= SWAP_RESTARTS; attempt++) {
		if (attempt > 0) await backoff(attempt - 1);
		const fetched = await fetchRemote(exec, root, n);
		if (!fetched.ok) return fetched;
		const local = await integrate(exec, root, n, fetched.remoteTip);
		if (local !== LOST) return { ok: true, local, remoteTip: fetched.remoteTip };
	}
	return { ok: false, reason: `another writer kept moving refs/livespec/${n}; swap retries used up after ${SWAP_RESTARTS + 1} attempts` };
}

const LOST = Symbol("lost swap");

/** Brings the local ref onto `remoteTip` (fast-forward, or replay when diverged) and returns the local tip, or `LOST`. */
async function integrate(exec: GitExec, root: string, n: number, remoteTip: string | undefined): Promise<string | undefined | typeof LOST> {
	const ref = ledgerRef(n);
	const local = await readRef(exec, root, ref);
	if (remoteTip === undefined || local === remoteTip) return local;
	if (local !== undefined && (await isAncestor(exec, root, remoteTip, local))) return local;
	const next = await integratedTip(exec, root, n, local, remoteTip);
	return (await swapRef(exec, root, ref, next, local)) ? next : LOST;
}

/** The commit the local ref should move to: the remote tip itself, or a replay of local-only entries onto it. */
async function integratedTip(exec: GitExec, root: string, n: number, local: string | undefined, remoteTip: string): Promise<string> {
	if (local === undefined || (await isAncestor(exec, root, local, remoteTip))) return remoteTip;
	const replayed = planReplay(await readTree(exec, root, local, n), await readTree(exec, root, remoteTip, n));
	return replayed.length === 0 ? remoteTip : commitEntries(exec, root, n, remoteTip, replayed);
}

/** Pushes `local` without force; on success the tracking ref moves forward to it (never back). */
async function pushLocal(exec: GitExec, root: string, n: number, local: string): Promise<SyncResult | "rejected"> {
	let outcome: "pushed" | "rejected";
	try {
		outcome = await ledgerPush(exec, root, n, local);
	} catch (error) {
		if (error instanceof GitError) return { status: "pending", reason: `push to origin failed: ${error.stderr.trim() || error.message}` };
		throw error;
	}
	if (outcome === "rejected") return outcome;
	await advanceRef(exec, root, trackingRef(n), local, TRACKING_RETRIES);
	return { status: "synced" };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
