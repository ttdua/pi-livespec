// Bounded memory of what each handed-out version looked like, so a conflict
// can name the changed fields. Fail-closed: an evicted or unknown snapshot only
// loses the field names, never the conflict itself.

import type { Version } from "./types.ts";
import type { ComparableIssue } from "./version.ts";

export type SnapshotKind = "issue" | "pull";

export const DEFAULT_SNAPSHOT_LIMIT = 256;

export class SnapshotStore {
	private readonly entries = new Map<string, ComparableIssue>();
	private readonly limit: number;

	constructor(limit: number = DEFAULT_SNAPSHOT_LIMIT) {
		if (!Number.isInteger(limit) || limit < 1) throw new RangeError("snapshot limit must be a positive integer");
		this.limit = limit;
	}

	get size(): number {
		return this.entries.size;
	}

	/** Stores a copy of the comparable fields only; evicts the oldest entries beyond the limit. */
	remember(kind: SnapshotKind, n: number, version: Version, value: ComparableIssue): void {
		const key = keyOf(kind, n, version);
		this.entries.delete(key); // re-inserting refreshes the position
		this.entries.set(key, copyOf(value));
		while (this.entries.size > this.limit) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.entries.delete(oldest.value);
		}
	}

	/** A copy of the stored fields, or `undefined` when unknown or evicted. */
	recall(kind: SnapshotKind, n: number, version: Version): ComparableIssue | undefined {
		const found = this.entries.get(keyOf(kind, n, version));
		return found === undefined ? undefined : copyOf(found);
	}
}

function keyOf(kind: SnapshotKind, n: number, version: Version): string {
	return `${kind}#${n}@${version}`;
}

function copyOf(v: ComparableIssue): ComparableIssue {
	return { title: v.title, body: v.body, labels: [...v.labels], state: v.state };
}
