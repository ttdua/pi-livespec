// Record kinds stored in the git ledger (`refs/livespec/<issue>`) instead of forge comments.

export const LEDGER_KINDS = ["decision", "dispatch", "finding-summary", "receipt", "unit-start", "counter"] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

export function isLedgerKind(k: string): k is LedgerKind {
	return (LEDGER_KINDS as readonly string[]).includes(k);
}
