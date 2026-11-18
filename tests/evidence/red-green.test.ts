import { describe, expect, test } from "vitest";
import type { Unit } from "../../src/core/change.ts";
import { classifyRun, postOk, preExpectation } from "../../src/evidence/red-green.ts";
import type { VerifyRun } from "../../src/evidence/runner.ts";

const run = (r: Partial<VerifyRun>): VerifyRun => ({ exit: 0, timedOut: false, aborted: false, output: "", totalBytes: 0, ...r });

const unit = (kind?: "refactor"): Unit => ({
	id: "U1",
	title: "t",
	covers: [],
	files: [],
	doneMeans: [],
	scenarios: [],
	depends: [],
	...(kind ? { kind } : {}),
	done: false,
	statusLine: -1,
	statusText: "",
	startLine: 0,
	endLine: 0,
	raw: {},
});

describe("classifyRun", () => {
	test("exit 0 is green and exit 1 is red", () => {
		expect(classifyRun(run({ exit: 0 }))).toBe("green");
		expect(classifyRun(run({ exit: 1 }))).toBe("red");
		expect(classifyRun(run({ exit: 2 }))).toBe("red");
	});

	test("126, 127, spawn errors, timeouts and aborts are invalid", () => {
		expect(classifyRun(run({ exit: 126 }))).toEqual({ invalid: "not-runnable" });
		expect(classifyRun(run({ exit: 127 }))).toEqual({ invalid: "not-runnable" });
		expect(classifyRun(run({ exit: null, spawnError: "ENOENT" }))).toEqual({ invalid: "spawn" });
		expect(classifyRun(run({ exit: null, timedOut: true }))).toEqual({ invalid: "timeout" });
		expect(classifyRun(run({ exit: null, aborted: true }))).toEqual({ invalid: "aborted" });
	});

	test("a run killed by a signal without timeout or abort is not runnable", () => {
		expect(classifyRun(run({ exit: null }))).toEqual({ invalid: "not-runnable" });
	});
});

describe("expectations", () => {
	test("a refactor unit expects green at pre, others red", () => {
		expect(preExpectation(unit("refactor"))).toBe("green");
		expect(preExpectation(unit())).toBe("red");
	});

	test("post is ok only when green", () => {
		expect(postOk("green")).toBe(true);
		expect(postOk("red")).toBe(false);
		expect(postOk({ invalid: "timeout" })).toBe(false);
	});
});
