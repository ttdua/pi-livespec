import { describe, expect, test } from "vitest";
import { failureSignature } from "../../src/evidence/signature.ts";

describe("failureSignature", () => {
	test("vitest FAIL line", () => {
		expect(failureSignature(" FAIL tests/a.test.ts > adds\n").tests).toEqual(["tests/a.test.ts > adds"]);
	});

	test("go test FAIL line", () => {
		expect(failureSignature("--- FAIL: TestX (0.00s)\n").tests).toEqual(["TestX"]);
	});

	test("pytest FAILED line", () => {
		expect(failureSignature("FAILED tests/test_a.py::test_b - AssertionError\n").tests).toEqual(["tests/test_a.py::test_b"]);
	});

	test("TAP not ok line", () => {
		expect(failureSignature("TAP version 13\nnot ok 3 - parses\n").tests).toEqual(["parses"]);
	});

	test("list reporter lines drop the trailing duration", () => {
		expect(failureSignature("   × adds 12ms\n").tests).toEqual(failureSignature("   × adds 40ms\n").tests);
		expect(failureSignature("   × adds 12ms\n").tests).toEqual(["adds"]);
	});

	test("names are deduplicated and sorted", () => {
		expect(failureSignature("FAIL b > y\nFAIL a > x\nFAIL b > y\n").tests).toEqual(["a > x", "b > y"]);
	});

	test("noise does not change the hash", () => {
		const a = "\u001b[31mFAIL\u001b[0m t > adds 12ms\nat /tmp/abc/x.ts\n2026-11-17T10:00:00.123Z commit 0123456789abcdef0123456789abcdef01234567\nexpected 1 to be 2";
		const b = "FAIL t > adds 40ms\nat   /tmp/def/x.ts\n2025-01-02T03:04:05Z commit fedcba9876543210fedcba9876543210fedcba98\nexpected 1 to be 2";
		expect(failureSignature(a).hash).toBe(failureSignature(b).hash);
		expect(failureSignature(a).hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("a changed assertion message changes the hash", () => {
		expect(failureSignature("expected 'foo' to be 'bar'").hash).not.toBe(failureSignature("expected 'foo' to be 'baz'").hash);
	});
});
