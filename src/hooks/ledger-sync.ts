// The session-start ledger sync (ledger-store "Sync result and triggers"): pushes pending entries of the
// current change without delaying the start; `Ledger.background()` settles once it is done.

import type { Session } from "./session.ts";

const STEP = "ledger-sync";

/** Starts a sync of the current change's ledger, never awaited; a non-synced result is recorded. */
export function startLedgerSync(session: Session): void {
	const card = session.card;
	if (card.kind !== "change") return;
	void session.ledger.sync(card.state.issue.number).then(
		(r) => {
			if (r.status === "error") session.record(STEP, r.message);
		},
		(error: unknown) => session.record(STEP, error),
	);
}
