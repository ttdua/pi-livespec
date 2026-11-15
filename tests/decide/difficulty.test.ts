import { describe, expect, test } from "vitest";
import { type DifficultyFacts, difficultyRule } from "../../src/decide/rules/difficulty.ts";

function run(f: Partial<DifficultyFacts>) {
	const r = difficultyRule({ tags: [], covers: [], files: [], ...f }, { mode: "rule" });
	if (!("outcome" in r)) throw new Error("difficulty never asks");
	return r;
}

describe("difficulty rule", () => {
	test("Two capabilities", () => {
		expect(run({ covers: ["rate-limit/Requirement: A", "auth/Requirement: B"], files: ["a.ts"] }).outcome).toBe("high");
	});

	test("Medium default", () => {
		expect(run({ files: ["a.tsx", "b.tsx"], tags: ["ui"] }).outcome).toBe("medium");
	});

	test("security tag is high", () => {
		expect(run({ files: ["a.ts"], tags: ["security"] }).outcome).toBe("high");
	});

	test("migration tag is high", () => {
		expect(run({ files: ["a.sql"], tags: ["migration"] }).outcome).toBe("high");
	});

	test("five files is high", () => {
		expect(run({ files: ["1", "2", "3", "4", "5"] }).outcome).toBe("high");
	});

	test("four files is medium", () => {
		expect(run({ files: ["1", "2", "3", "4"] }).outcome).toBe("medium");
	});

	test("one file without tags is low", () => {
		const r = run({ files: ["a.ts"], covers: ["cap/Requirement: A", "cap/Requirement: B"] });
		expect(r.outcome).toBe("low");
		expect(r.reason).toContain("1 file");
	});

	test("one file with a tag is medium", () => {
		expect(run({ files: ["a.ts"], tags: ["perf"] }).outcome).toBe("medium");
	});
});
