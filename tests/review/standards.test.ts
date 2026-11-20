import { describe, expect, it } from "vitest";
import { checkStandards } from "../../src/review/standards.ts";

const CITE = { constraintsCited: false };

// Build a one-file unified diff; `body` is the raw hunk body lines.
function fileDiff(path: string, hunkHeader: string, body: string[]): string {
	return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, hunkHeader, ...body].join("\n");
}

function locations(diff: string, opts = CITE): string[] {
	return checkStandards(diff, opts).map((f) => f.location);
}

describe("checkStandards: added skip or only", () => {
	it("flags it.skip at the new line number", () => {
		const diff = fileDiff("test/limit.test.ts", "@@ -10,0 +12,1 @@", [`+  it.skip("limits", () => {`]);
		const findings = checkStandards(diff, CITE);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			severity: "CRITICAL",
			kind: "lowered-standard",
			scope: "unit",
			location: "test/limit.test.ts:12",
		});
	});

	it.each([
		['+  xit("a", () => {'],
		['+  describe.only("a", () => {'],
		['+  xdescribe("a", () => {'],
	])("flags %s", (line) => {
		expect(locations(fileDiff("test/a.test.ts", "@@ -1,0 +1,1 @@", [line]))).toEqual(["test/a.test.ts:1"]);
	});
});

describe("checkStandards: suppression comments", () => {
	it("flags @ts-ignore", () => {
		const diff = fileDiff("src/a.ts", "@@ -1,0 +5,1 @@", ["+// @ts-ignore"]);
		expect(locations(diff)).toEqual(["src/a.ts:5"]);
	});

	it.each(["+// @ts-expect-error", "+// @ts-expect-error:", "+// @ts-expect-error:   "])(
		"flags bare expect-error %j",
		(line) => {
			expect(locations(fileDiff("src/a.ts", "@@ -1,0 +1,1 @@", [line]))).toEqual(["src/a.ts:1"]);
		},
	);

	it("does not flag expect-error with a reason", () => {
		const diff = fileDiff("src/a.ts", "@@ -1,0 +1,1 @@", ["+// @ts-expect-error: the vendor type is wrong"]);
		expect(locations(diff)).toEqual([]);
	});

	it.each(["+/* eslint-disable */", "+// eslint-disable-next-line no-console"])("flags %s", (line) => {
		expect(locations(fileDiff("src/a.ts", "@@ -1,0 +1,1 @@", [line]))).toEqual(["src/a.ts:1"]);
	});
});

describe("checkStandards: deleted test files", () => {
	it("flags a deleted test file at line 1", () => {
		const diff = [
			"diff --git a/test/old.test.ts b/test/old.test.ts",
			"deleted file mode 100644",
			"--- a/test/old.test.ts",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-it('x', () => {})",
			"-",
		].join("\n");
		expect(locations(diff)).toEqual(["test/old.test.ts:1"]);
	});

	it("does not flag a deleted source file", () => {
		const diff = [
			"diff --git a/src/old.ts b/src/old.ts",
			"deleted file mode 100644",
			"--- a/src/old.ts",
			"+++ /dev/null",
			"@@ -1,1 +0,0 @@",
			"-export const x = 1;",
		].join("\n");
		expect(locations(diff)).toEqual([]);
	});
});

describe("checkStandards: removed assertions", () => {
	it("flags a net removal at the first removed line's old number", () => {
		const diff = fileDiff("test/a.test.ts", "@@ -20,3 +20,1 @@", [
			"-  expect(a).toBe(1);",
			"-  expect(b).toBe(2);",
			"-  expect(c).toBe(3);",
			"+  expect(a).toBe(1);",
		]);
		const findings = checkStandards(diff, CITE);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.location).toBe("test/a.test.ts:20");
	});

	it("does not flag an equal count of removed and added assertions", () => {
		const diff = fileDiff("test/a.test.ts", "@@ -20,2 +20,2 @@", [
			"-  expect(a).toBe(1);",
			"-  expect(b).toBe(2);",
			"+  expect(a).toBe(3);",
			"+  expect(b).toBe(4);",
		]);
		expect(locations(diff)).toEqual([]);
	});

	it("ignores removed assertions in a non-test file", () => {
		const diff = fileDiff("src/a.ts", "@@ -5,2 +5,0 @@", ["-  expect(a).toBe(1);", "-  assert(b);"]);
		expect(locations(diff)).toEqual([]);
	});
});

describe("checkStandards: constraints citation", () => {
	it("cites specs/constraints.md in the evidence when it exists", () => {
		const diff = fileDiff("test/limit.test.ts", "@@ -10,0 +12,1 @@", [`+  it.skip("limits", () => {`]);
		const [finding] = checkStandards(diff, { constraintsCited: true });
		expect(finding?.evidence).toContain("specs/constraints.md");
	});
});
