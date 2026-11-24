// The local audit state: the suggestion cursors and the pending audit reasons.

export type PendingAudit = { kind: "initiative"; initiative: number } | { kind: "commit"; sha: string; capabilities: string[] };

export type AuditState = {
	/** Last first-parent commit of the integration branch checked for suggestions. */
	cursor?: string;
	/** Audited commit up to which the `declared-none` detector last ran to the end. */
	fixCursor?: string;
	auditedCommit?: string;
	pending: PendingAudit[];
};
