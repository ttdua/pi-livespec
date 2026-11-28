// One canonicalization seam for record references: a reference names a record by its `ref` or, for a
// migrated entry, by the forge comment id it was copied from (`from`).

import type { MarkedComment } from "../forge/markers.ts";
import { matchesRef } from "./merge.ts";

/** The `ref` of the record `ref` names, or `ref` itself when no record matches. */
export function canonicalRef(marked: MarkedComment[], ref: string): string {
	return marked.find((m) => matchesRef(m, ref))?.ref ?? ref;
}

/** A `<ref>:<index>` finding key with its ref canonicalized; a key without an index is returned as is. */
export function canonicalKey(marked: MarkedComment[], key: string): string {
	const cut = key.lastIndexOf(":");
	return cut <= 0 ? key : `${canonicalRef(marked, key.slice(0, cut))}${key.slice(cut)}`;
}
