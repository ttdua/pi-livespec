// Ledger fixtures for tests without a repository: an empty in-memory ledger, and ledger records
// built the way `mergeRecords` maps entries, for pure readers of `MarkedComment[]`.

import type { LedgerKind } from "../../src/core/record-kinds.ts";
import type { MarkedComment } from "../../src/forge/markers.ts";
import type { AppendInput } from "../../src/ledger/entry.ts";
import type { Ledger } from "../../src/ledger/index.ts";

/** A ledger with no entries that is always fetched and never pending; `append` refuses. */
export function emptyLedger(): Ledger {
	return {
		read: async () => ({ entries: [], warnings: [] }),
		append: async () => {
			throw new Error("emptyLedger does not take appends");
		},
		ensureFetched: async () => "fetched",
		sync: async () => ({ status: "synced" }),
		pending: async () => false,
		remove: async () => ({ remote: "gone" }),
		background: async () => {},
	};
}

let refCounter = 0;

/** A `source: "ledger"` record for `input`; `ref` defaults to `<id>~<8 hex>`, unique per call. */
export function ledgerRecord(input: AppendInput & { kind: LedgerKind }, opts: { ref?: string; at?: string; from?: string } = {}): MarkedComment {
	const ref = opts.ref ?? `${input.id}~${(++refCounter).toString(16).padStart(8, "0")}`;
	return {
		ref,
		source: "ledger",
		kind: input.kind,
		id: input.id,
		author: "",
		data: input.data,
		createdAt: opts.at ?? new Date(0).toISOString(),
		...(opts.from === undefined ? {} : { from: opts.from }),
	};
}
