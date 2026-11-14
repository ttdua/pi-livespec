import { describe, expect, it } from "vitest";
import { parseDecision } from "../../src/core/decision.ts";
import { validateDecisionDiff, validateDecisions } from "../../src/core/validate-decisions.ts";

const d = (file: string, fm: string) => parseDecision(`specs/decisions/${file}`, `---\n${fm}\n---\n# t\n`);

describe("validate-decisions.test", () => {
	it("duplicate number", () => {
		const r = validateDecisions([d("0003-a.md", "status: accepted"), d("0003-b.md", "status: accepted")]);
		expect(r.map((x) => x.code)).toEqual(["decision-number"]);
	});

	it("superseded without pointer", () => {
		const r = validateDecisions([d("0001-a.md", "status: superseded")]);
		expect(r.map((x) => x.code)).toEqual(["decision-superseded"]);
	});

	it("pointer to missing decision", () => {
		const r = validateDecisions([d("0001-a.md", "status: superseded\nsuperseded_by: 9")]);
		expect(r.map((x) => x.code)).toEqual(["decision-superseded"]);
	});

	it("missing status is reported", () => {
		const r = validateDecisions([d("0001-a.md", "spine: false")]);
		expect(r.map((x) => x.code)).toEqual(["decision-status"]);
		expect(r[0]?.file).toBe("specs/decisions/0001-a.md");
	});

	it("bogus status is reported", () => {
		const r = validateDecisions([d("0001-a.md", "status: maybe")]);
		expect(r.map((x) => x.code)).toEqual(["decision-status"]);
		expect(r[0]?.message).toContain("accepted");
	});

	it("non-numbered file reports the real file name", () => {
		const r = validateDecisions([d("notes.md", "status: accepted")]);
		expect(r.map((x) => x.code)).toEqual(["decision-number"]);
		expect(r[0]?.file).toBe("specs/decisions/notes.md");
		expect(r[0]?.message).not.toContain("NaN");
	});

	it("valid supersession", () => {
		const r = validateDecisions([
			d("0001-a.md", "status: superseded\nsuperseded_by: 2"),
			d("0002-b.md", "status: accepted"),
		]);
		expect(r).toEqual([]);
	});

	it("decision deleted in diff", () => {
		const diff = [
			"diff --git a/specs/decisions/0001-x.md b/specs/decisions/0001-x.md",
			"deleted file mode 100644",
			"index 1234567..0000000",
			"--- a/specs/decisions/0001-x.md",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-# x",
			"",
		].join("\n");
		const r = validateDecisionDiff(diff);
		expect(r.map((x) => x.code)).toEqual(["decision-deleted"]);
		expect(r[0]?.file).toBe("specs/decisions/0001-x.md");
		expect(r[0]?.message).toContain("never deleted");
	});

	it("modified decision and deleted other files are fine", () => {
		const diff = [
			"diff --git a/specs/decisions/0001-x.md b/specs/decisions/0001-x.md",
			"--- a/specs/decisions/0001-x.md",
			"+++ b/specs/decisions/0001-x.md",
			"@@ -1 +1 @@",
			"diff --git a/specs/cache/spec.md b/specs/cache/spec.md",
			"deleted file mode 100644",
			"",
		].join("\n");
		expect(validateDecisionDiff(diff)).toEqual([]);
	});
});

describe("validate-decisions diff regressions", () => {
	const header = (a: string, b = a) => `diff --git a/${a} b/${b}`;

	it("deleting a non-decision file after a decision edit is not an error", () => {
		const diff = [
			header("specs/decisions/0001-x.md"),
			"--- a/specs/decisions/0001-x.md",
			"+++ b/specs/decisions/0001-x.md",
			"@@ -1 +1 @@",
			header("specs/cache/spec.md"),
			"deleted file mode 100644",
		].join("\n");
		expect(validateDecisionDiff(diff)).toEqual([]);
	});

	it("deleting a decision after a non-decision edit is reported", () => {
		const diff = [
			header("specs/cache/spec.md"),
			"--- a/specs/cache/spec.md",
			"+++ b/specs/cache/spec.md",
			"@@ -1 +1 @@",
			header("specs/decisions/0002-y.md"),
			"deleted file mode 100644",
		].join("\n");
		expect(validateDecisionDiff(diff).map((x) => x.file)).toEqual(["specs/decisions/0002-y.md"]);
	});

	it("paths with spaces in a deleted decision are reported with the real name", () => {
		const diff = [
			header("specs/decisions/0003-my note.md"),
			"deleted file mode 100644",
			"--- a/specs/decisions/0003-my note.md",
			"+++ /dev/null",
		].join("\n");
		expect(validateDecisionDiff(diff).map((x) => x.file)).toEqual(["specs/decisions/0003-my note.md"]);
	});

	it("renaming a decision out of decisions/ is reported as a deletion", () => {
		const diff = [
			header("specs/decisions/0004-z.md", "specs/cache/z.md"),
			"similarity index 90%",
			"rename from specs/decisions/0004-z.md",
			"rename to specs/cache/z.md",
		].join("\n");
		expect(validateDecisionDiff(diff).map((x) => x.file)).toEqual(["specs/decisions/0004-z.md"]);
	});

	it("renaming a decision within decisions/ is allowed", () => {
		const diff = [
			header("specs/decisions/0004-z.md", "specs/decisions/0004-renamed.md"),
			"similarity index 90%",
			"rename from specs/decisions/0004-z.md",
			"rename to specs/decisions/0004-renamed.md",
		].join("\n");
		expect(validateDecisionDiff(diff)).toEqual([]);
	});
});
