import { LineCounter, parseDocument } from "yaml";
import { beforeEach, describe, expect, test } from "vitest";
import { mergeDecisions, registerBuiltinRules, registerRule, resetRulesForTests, ruleFor } from "../../src/decide/registry.ts";
import { decide } from "../../src/decide/seam.ts";
import { validatePackDocument } from "../../src/engine/pack-schema.ts";
import { getPackSchema, resetRegistryForTests } from "../../src/engine/registry.ts";

function validate(decisions: string) {
	const text = `name: p\nversion: 1\ncontent: c\nphases: []\ndecisions:\n${decisions}`;
	const lc = new LineCounter();
	const doc = parseDocument(text, { keepSourceTokens: false, lineCounter: lc });
	return validatePackDocument(doc, "flow.yaml", lc, "pack");
}

function at(errors: ReturnType<typeof validate>) {
	return errors.map((e) => ({ file: e.file, line: e.line, col: e.col }));
}

beforeEach(() => {
	resetRegistryForTests();
	resetRulesForTests();
	registerBuiltinRules();
});

describe("decisions schema", () => {
	test("Jev rejected", () => {
		const errors = validate("  tags:\n    mode: jev\n");
		expect(at(errors)).toEqual([{ file: "flow.yaml", line: 7, col: 11 }]);
		expect(errors[0]?.message).toBe("`jev` is reserved for a later version; use `mode: rule`");
	});

	test("Unknown point", () => {
		const errors = validate("  lane: { mode: rule }\n");
		expect(at(errors)).toEqual([{ file: "flow.yaml", line: 6, col: 3 }]);
		expect(errors[0]?.message).toBe("no rule is registered for decision point `lane`");
	});

	test("missing mode is an error", () => {
		const errors = validate("  difficulty: {}\n");
		expect(at(errors)).toEqual([{ file: "flow.yaml", line: 6, col: 15 }]);
		expect(errors[0]?.message).toBe("`mode` must be `rule`");
	});

	test("other mode is an error", () => {
		const errors = validate("  difficulty: { mode: auto }\n");
		expect(at(errors)).toEqual([{ file: "flow.yaml", line: 6, col: 23 }]);
		expect(errors[0]?.message).toBe("`mode` must be `rule`");
	});

	test("tags config with a non-list glob is an error", () => {
		const errors = validate("  tags:\n    mode: rule\n    paths:\n      security: \"**/auth/**\"\n");
		expect(at(errors)).toEqual([{ file: "flow.yaml", line: 9, col: 17 }]);
		expect(errors[0]?.message).toContain("security");
	});

	test("valid rule config has no errors", () => {
		expect(validate("  tags: { mode: rule, paths: { ui: ['**/*.tsx'] }, keywords: { perf: [cache] } }\n  difficulty: { mode: rule }\n")).toEqual([]);
	});

	test("registerBuiltinRules re-registers after a reset", () => {
		resetRegistryForTests();
		resetRulesForTests();
		expect(getPackSchema("decisions")).toBeUndefined();
		expect(ruleFor("tags")).toBeUndefined();
		registerBuiltinRules();
		expect(getPackSchema("decisions")).toBeDefined();
		expect(ruleFor("tags")).toBeDefined();
		expect(ruleFor("difficulty")).toBeDefined();
		expect(validate("  difficulty: { mode: rule }\n")).toEqual([]);
	});
});

describe("mergeDecisions", () => {
	test("uses the per-point merge and a one-level spread otherwise", () => {
		registerRule("custom", { validate() {} }, () => ({ outcome: 1, reason: "r" }));
		const merged = mergeDecisions(
			{ tags: { mode: "rule", paths: { security: ["**/auth/**"] } }, custom: { mode: "rule", a: 1 } },
			{ tags: { paths: { security: ["**/crypto/**"] } }, custom: { b: 2 } },
		);
		expect(merged).toEqual({
			tags: { mode: "rule", paths: { security: ["**/auth/**", "**/crypto/**"] }, keywords: {} },
			custom: { mode: "rule", a: 1, b: 2 },
		});
	});
});

describe("finding-scope rule", () => {
	test("the pack accepts decisions.finding-scope: { mode: rule }", () => {
		resetRulesForTests();
		registerBuiltinRules();
		expect(validate("  finding-scope: { mode: rule }\n")).toEqual([]);
	});

	test("decide answers by rule", async () => {
		resetRulesForTests();
		registerBuiltinRules();
		const finding = { severity: "WARNING", kind: "defect", location: "src/a.ts:1", evidence: "e", fix: "f", scope: "unit" };
		const facts = { finding, path: "src/a.ts", units: [{ id: "U1", files: ["src/a.ts"] }], diffFiles: [], needsDecision: false };
		const decided = await decide("finding-scope", facts, { config: { mode: "rule" }, subject: "review-1" });
		expect(decided).toMatchObject({ status: "decided", source: "rule", outcome: { route: "unit", unit: "U1" } });
	});
});
