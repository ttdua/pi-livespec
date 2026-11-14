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
