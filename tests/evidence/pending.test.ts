import { describe, expect, test } from "vitest";
import type { Unit } from "../../src/core/change.ts";
import { isTestFile, pendingDecision, testOnlyCommitCheck } from "../../src/evidence/pending.ts";

const unit = (files: string[]): Unit => ({
	id: "U1",
	title: "t",
	covers: [],
	files,
	doneMeans: [],
	scenarios: [],
	depends: [],
	done: false,
	statusLine: -1,
	statusText: "",
	startLine: 0,
	endLine: 0,
	raw: {},
});

describe("verifier pending", () => {
	test("isTestFile matches the six patterns", () => {
		for (const p of ["src/a.test.ts", "a.spec.js", "pkg/limit_test.go", "py/test_limit.py", "tests/helpers.ts", "a/test/x.rb"]) {
			expect(isTestFile(p), p).toBe(true);
		}
		for (const p of ["src/limit.ts", "src/testing.ts", "contest/a.ts", "README.md"]) expect(isTestFile(p), p).toBe(false);
	});

	test("pendingDecision", () => {
		const u = unit(["src/limit.ts", "test/limit.test.ts"]);
		expect(pendingDecision(u, (p) => p === "src/limit.ts")).toBe(true);
		expect(pendingDecision(u, () => true)).toBe(false);
		expect(pendingDecision(unit(["src/limit.ts"]), () => false)).toBe(false);
	});

	test("testOnlyCommitCheck names src/limit.ts as extra", () => {
		const u = unit(["src/limit.ts", "test/limit.test.ts"]);
		const pending = ["test/limit.test.ts"];
		expect(testOnlyCommitCheck(u, ["test/limit.test.ts", "src/limit.ts"], pending)).toEqual({ ok: false, extra: ["src/limit.ts"] });
		expect(testOnlyCommitCheck(u, ["test/limit.test.ts"], pending)).toEqual({ ok: true });
		expect(testOnlyCommitCheck(u, ["test/other.test.ts"], pending)).toEqual({ ok: false, extra: ["test/other.test.ts"] });
	});

	test("testOnlyCommitCheck refuses a commit that changes no pending test file", () => {
		const u = unit(["src/limit.ts", "test/limit.test.ts", "test/old.test.ts"]);
		const pending = ["test/limit.test.ts"];
		expect(testOnlyCommitCheck(u, [], pending)).toEqual({ ok: false, missing: ["test/limit.test.ts"] });
		expect(testOnlyCommitCheck(u, ["test/old.test.ts"], pending)).toEqual({ ok: false, missing: ["test/limit.test.ts"] });
		expect(testOnlyCommitCheck(u, ["test/old.test.ts", "test/limit.test.ts"], pending)).toEqual({ ok: true });
	});
});
