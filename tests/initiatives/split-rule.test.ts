import { isMap, LineCounter, parseDocument } from "yaml";
import { describe, expect, test } from "vitest";
import { registerBuiltinRules, ruleFor } from "../../src/decide/registry.ts";
import { splitFacts, splitRuleFn, splitSchema } from "../../src/initiatives/split-rule.ts";
import { sizedChange } from "./fixture.ts";

const LIMITS = { max_units: 8, max_capabilities: 3 };
const CONFIG = { mode: "rule" };

describe("split rule", () => {
	test("facts count capabilities and units", () => {
		expect(splitFacts(sizedChange(2, 5), { ...LIMITS, other: 1 })).toEqual({ capabilities: 2, units: 5, limits: LIMITS });
	});

	test("Too many capabilities suggests an initiative", () => {
		const result = splitRuleFn(splitFacts(sizedChange(4, 0), LIMITS), CONFIG);
		expect(result).toEqual({ outcome: "propose", reason: "4 capabilities exceed max_capabilities 3" });
	});

	test("too many units suggests an initiative", () => {
		expect(splitRuleFn(splitFacts(sizedChange(1, 9), LIMITS), CONFIG)).toMatchObject({ outcome: "propose" });
	});

	test("Within limits", () => {
		const result = splitRuleFn(splitFacts(sizedChange(2, 0), LIMITS), CONFIG);
		expect(result).toMatchObject({ outcome: "single" });
		expect("ask" in result).toBe(false);
	});

	test("missing limits never propose", () => {
		expect(splitRuleFn(splitFacts(sizedChange(9, 20), {}), CONFIG)).toMatchObject({ outcome: "single" });
	});

	test("is registered", () => {
		registerBuiltinRules();
		expect(ruleFor("split")?.fn).toBe(splitRuleFn);
	});
});

function schemaErrors(src: string): { line: number; col: number; message: string }[] {
	const lc = new LineCounter();
	const doc = parseDocument(src, { lineCounter: lc });
	const node = doc.contents;
	if (!isMap(node)) throw new Error("map expected");
	const errors: { line: number; col: number; message: string }[] = [];
	splitSchema.validate(node, (n, message) => {
		const pos = lc.linePos(n.range?.[0] ?? 0);
		errors.push({ line: pos.line, col: pos.col, message });
	});
	return errors;
}

describe("splitSchema", () => {
	test("mode only is valid", () => {
		expect(schemaErrors("mode: rule\n")).toEqual([]);
	});

	test("a key other than mode is reported", () => {
		const errors = schemaErrors("mode: rule\nmax_units: 3\n");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ line: 2, col: 1 });
		expect(errors[0]?.message).toContain("max_units");
	});
});
