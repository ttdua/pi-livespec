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

export type TestOnlyCheck = { ok: true } | { ok: false; extra: string[] } | { ok: false; missing: string[] };

/**
 * The first commit after a pending start may change only test files listed in the unit's `Files`, and must
 * add or change at least one of its `pending` test files (listed and missing at the start).
 */
export function testOnlyCommitCheck(u: Unit, changed: string[], pending: string[]): TestOnlyCheck {
	const allowed = new Set(u.files.filter(isTestFile));
	const extra = changed.filter((path) => !allowed.has(path));
	if (extra.length > 0) return { ok: false, extra };
	return changed.some((path) => pending.includes(path)) ? { ok: true } : { ok: false, missing: pending };
}
