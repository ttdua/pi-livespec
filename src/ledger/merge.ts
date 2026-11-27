// One causally ordered list of own records: forge comments in forge order, each ledger entry
// placed after the comment its `after` anchor names (design D3).

import type { MarkedComment } from "../forge/markers.ts";
import type { LedgerEntry } from "./entry.ts";

/** The slot of entries placed before every comment. */
const BEFORE_ALL = -1;

/** The own comments and entries as one list; every "latest"/"newer" comparison uses positions in it. */
export function mergeRecords(comments: MarkedComment[], entries: LedgerEntry[]): MarkedComment[] {
	const slots = new Map<number, MarkedComment[]>();
	for (const entry of bySeq(entries)) {
		const slot = slotOf(comments, entry);
		const placed = slots.get(slot);
		if (placed) placed.push(asRecord(entry));
		else slots.set(slot, [asRecord(entry)]);
	}
	return [...(slots.get(BEFORE_ALL) ?? []), ...comments.flatMap((c, i) => [c, ...(slots.get(i) ?? [])])];
}

/** True when `ref` names `m`: its own reference, or the forge comment a migrated entry was copied from. */
export function matchesRef(m: MarkedComment, ref: string): boolean {
	return m.ref === ref || m.from === ref;
}

/** The reference of the last forge record, the `after` anchor of an entry appended now. */
export function lastForgeRef(marked: MarkedComment[]): string | undefined {
	for (let i = marked.length - 1; i >= 0; i--) if (marked[i]?.source === "forge") return marked[i]?.ref;
	return undefined;
}

/** Ledger file order: by `seq`, stable for equal values. */
function bySeq(entries: LedgerEntry[]): LedgerEntry[] {
	return entries.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.seq - b.entry.seq || a.index - b.index).map(({ entry }) => entry);
}

/** The comment index the entry follows: its anchor, else the last comment created at or before it. */
function slotOf(comments: MarkedComment[], entry: LedgerEntry): number {
	const anchor = entry.after === undefined ? -1 : comments.findIndex((c) => c.ref === entry.after);
	if (anchor !== -1) return anchor;
	const at = Date.parse(entry.at);
	let last = BEFORE_ALL;
	comments.forEach((c, i) => {
		if (c.createdAt !== undefined && Date.parse(c.createdAt) <= at) last = i;
	});
	return last;
}

function asRecord(e: LedgerEntry): MarkedComment {
	return { ref: e.ref, source: "ledger", kind: e.kind, id: e.id, author: "", data: e.data, createdAt: e.at, ...(e.from === undefined ? {} : { from: e.from }) };
}
