// The failure signature of a failed `Verify` run: failing test names plus a normalized output hash.

import { createHash } from "node:crypto";

export type Signature = { tests: string[]; hash: string };

/** Line patterns that name a failing test; group 1 is the name. */
const TEST_NAME_PATTERNS: RegExp[] = [
	/^\s*FAIL\s+(.+?)\s*$/, // vitest, jest
	/^\s*[✗×]\s+(.+?)\s*$/, // vitest, jest list reporters
	/^\s*--- FAIL:\s+(\S+)/, // go test
	/^\s*FAILED\s+(\S+)/, // pytest
	/^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/, // TAP
];

/** Normalizations applied in order before hashing; earlier ones protect their matches from later ones. */
const NORMALIZATIONS: [RegExp, string][] = [
	[/\u001b\[[0-9;?]*[A-Za-z]/g, ""], // ANSI codes
	[/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>"], // ISO timestamps
	[/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>"], // clock times
	[/\b[0-9a-f]{7,}\b/gi, "<hex>"], // SHAs and other hex runs
	[/(?:[A-Za-z]:)?(?:\/[^\s/:'"`()<>]+)+\/?/g, "<path>"], // absolute paths
	[/\b\d+(?:\.\d+)?\s?(?:ns|µs|us|ms|s|m|h)\b/g, "<dur>"], // durations
	[/\d+/g, "<n>"], // other digit runs
	[/\s+/g, " "], // whitespace
];

/** A trailing duration a reporter prints after a test name: `12ms`, `1.2 s`, `(5.2 s)`. */
const TRAILING_DURATION = /\s+\(?\d+(?:\.\d+)?\s?(?:ms|s)\)?$/;

const stripAnsi = (line: string): string => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

function testNames(output: string): string[] {
	const names = new Set<string>();
	for (const line of output.split(/\r?\n/)) {
		const plain = stripAnsi(line);
		for (const pattern of TEST_NAME_PATTERNS) {
			const match = pattern.exec(plain);
			if (match?.[1]) {
				names.add(match[1].replace(TRAILING_DURATION, ""));
				break;
			}
		}
	}
	return [...names].sort();
}

function normalize(output: string): string {
	return NORMALIZATIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), output).trim();
}

/** The sorted, deduplicated failing test names and the sha256 of the normalized output. */
export function failureSignature(output: string): Signature {
	return { tests: testNames(output), hash: createHash("sha256").update(normalize(output)).digest("hex") };
}
