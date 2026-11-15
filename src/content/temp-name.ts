// Per-writer temp names, so concurrent writers never share a temp path.

import { randomBytes } from "node:crypto";

const SUFFIX_BYTES = 4;

/** `<path>.tmp-<pid>-<random>`. */
export function uniqueTempPath(path: string): string {
	return `${path}.tmp-${process.pid}-${randomBytes(SUFFIX_BYTES).toString("hex")}`;
}
