// Replay planning: which local entries a diverged ledger must re-append onto the remote tip.

import type { LedgerEntry, LedgerRead } from "./entry.ts";

/**
 * The entries of `local` whose `ref` `remote` lacks, in local order (by `seq`), renumbered after the
 * highest remote `seq`. Every other field is kept, so `entryVersion` does not change.
 */
export function planReplay(local: LedgerRead, remote: LedgerRead): LedgerEntry[] {
	const known = new Set(remote.entries.map((e) => e.ref));
	let seq = remote.entries.reduce((max, e) => Math.max(max, e.seq), 0);
	return local.entries.filter((e) => !known.has(e.ref)).map((e) => ({ ...e, seq: ++seq }));
}
