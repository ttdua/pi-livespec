// Drift items: the types the audit reports, their stable keys, and the pull
// request number a commit subject names.

export type DriftType =
	| "scenario-untested"
	| "removed-reference"
	| "dead-paths"
	| "unused-term"
	| "stale-decision"
	| "product-missing"
	| "declared-none";

export type DriftItem = {
	type: DriftType;
	/** `<type>:<subject>`; stable across audits so a re-triage can name it. */
	key: string;
	subject: string;
	capability?: string;
	evidence: string;
	/** Set by the scout confirmation; absent means unconfirmed or not sent. */
	confirmed?: boolean;
};

/** Builds an item with its key derived from type and subject. */
export function driftItem(type: DriftType, subject: string, evidence: string, capability?: string): DriftItem {
	const item: DriftItem = { type, key: `${type}:${subject}`, subject, evidence };
	if (capability !== undefined) item.capability = capability;
	return item;
}

const SQUASH_SUBJECT = /\(#(\d+)\)\s*$/;
const MERGE_SUBJECT = /^Merge pull request #(\d+)/;

/** The pull request number named by a commit subject (`... (#N)` or `Merge pull request #N ...`). */
export function pullRequestOf(subject: string): number | undefined {
	const m = SQUASH_SUBJECT.exec(subject) ?? MERGE_SUBJECT.exec(subject);
	return m ? Number(m[1]) : undefined;
}
