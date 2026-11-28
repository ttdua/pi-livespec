// The ledger of a change as one object: local reads, appends that refuse an unknown ledger
// while offline, sync with origin, retention removal, and tracking of background syncs.

import type { GitExec } from "../engine/git-exec.ts";
import { type AppendInput, type LedgerEntry, LedgerError, type LedgerRead } from "./entry.ts";
import { appendEntry, readLedger } from "./store.ts";
import { type FetchState, type RemoveResult, type SyncResult, fetchLedger, hasKnownLedger, isPending, removeRemote, syncLedger } from "./sync.ts";

export type { FetchState, RemoveResult, SyncResult } from "./sync.ts";

export type Ledger = {
	/** The entries at the local tip; never touches the network. */
	read(n: number): Promise<LedgerRead>;
	/** Appends after a successful (or known-stale) fetch, then syncs in the background. */
	append(n: number, input: AppendInput): Promise<LedgerEntry>;
	/** Fetches and integrates the remote ledger once per Ledger instance. */
	ensureFetched(n: number): Promise<FetchState>;
	/** Fetches, integrates and pushes; tracked by `background()` like the syncs started after appends. */
	sync(n: number): Promise<SyncResult>;
	/** True when the local tip holds entries origin is not known to have; local refs only. */
	pending(n: number): Promise<boolean>;
	remove(n: number): Promise<RemoveResult>;
	/** Settles when every background sync started so far has settled. */
	background(): Promise<void>;
};

/** A ledger bound to the repository at `root`; fetch success is remembered for the lifetime of the object. */
export function createLedger(exec: GitExec, root: string): Ledger {
	const fetched = new Set<number>();
	const running = new Set<Promise<unknown>>();

	const fetching = new Map<number, Promise<FetchState>>();

	const fetchOnce = async (n: number): Promise<FetchState> => {
		if (await fetchLedger(exec, root, n)) {
			fetched.add(n);
			return "fetched";
		}
		return (await hasKnownLedger(exec, root, n)) ? "stale-known" : "unknown-offline";
	};

	/** Single-flight per change: concurrent callers share one fetch. */
	const ensureFetched = (n: number): Promise<FetchState> => {
		if (fetched.has(n)) return Promise.resolve("fetched");
		const running = fetching.get(n) ?? fetchOnce(n).finally(() => fetching.delete(n));
		fetching.set(n, running);
		return running;
	};

	const trackedSync = (n: number): Promise<SyncResult> => {
		const task = syncLedger(exec, root, n);
		running.add(task);
		void task.finally(() => running.delete(task));
		return task;
	};

	const startBackgroundSync = (n: number): void => {
		// Best-effort: a failed sync leaves the entry pending locally, which `pending(n)` reports.
		void trackedSync(n).catch(() => undefined);
	};

	return {
		read: (n) => readLedger(exec, root, n),
		ensureFetched,
		async append(n, input) {
			if ((await ensureFetched(n)) === "unknown-offline") {
				throw new LedgerError("unknown-offline", `the ledger of #${n} could not be fetched; reconnect and retry`);
			}
			const entry = await appendEntry(exec, root, n, input);
			startBackgroundSync(n);
			return entry;
		},
		sync: trackedSync,
		pending: (n) => isPending(exec, root, n),
		async remove(n) {
			await Promise.allSettled([...running]); // a background sync of this clone must not race the delete
			return removeRemote(exec, root, n);
		},
		async background() {
			await Promise.allSettled([...running]);
		},
	};
}
