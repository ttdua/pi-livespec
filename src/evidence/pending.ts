// Verifier pending: test-file patterns, the pending decision and the test-only commit check.

import type { Unit } from "../core/change.ts";
import { matchGlob } from "../core/glob.ts";

const TEST_FILE_PATTERNS = ["**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.*", "**/tests/**", "**/test/**"];

export function isTestFile(path: string): boolean {
	return TEST_FILE_PATTERNS.some((pattern) => matchGlob(pattern, path));
}

/** True when at least one test file in the unit's `Files` does not exist at the pre commit. */
export function pendingDecision(u: Unit, exists: (path: string) => boolean): boolean {
	return u.files.some((path) => isTestFile(path) && !exists(path));
}

/** The first commit after a pending start may change only test files listed in the unit's `Files`. */
export function testOnlyCommitCheck(u: Unit, changed: string[]): { ok: true } | { ok: false; extra: string[] } {
	const allowed = new Set(u.files.filter(isTestFile));
	const extra = changed.filter((path) => !allowed.has(path));
	return extra.length === 0 ? { ok: true } : { ok: false, extra };
}
