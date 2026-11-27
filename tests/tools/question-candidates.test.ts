import { describe, expect, test } from "vitest";
import { candidateRequest } from "../../src/tools/question-candidates.ts";

const CHOICE = { recommended: "A", rationale: "Simplest." };

describe("candidate labels", () => {
	test.each([["tab", "a\tb"], ["no-break space", "a\u00a0b"], ["ideographic space", "a\u3000b"]])("a %s inside a label is refused", (_n, label) => {
		const out = candidateRequest({ candidates: [{ label, description: "d" }, { label: "other", description: "d" }], ...CHOICE }, "Which?");
		expect(out).toHaveProperty("refused");
	});

	test("a single ordinary space is accepted", () => {
		const out = candidateRequest({ candidates: [{ label: "per user", description: "d" }, { label: "per ip", description: "d" }], ...CHOICE }, "Which?");
		expect(out).not.toHaveProperty("refused");
	});
});

describe("required fields", () => {
	const CANDS = [{ label: "a", description: "d" }, { label: "b", description: "d" }];
	test.each([
		["candidates", {}],
		["candidates", { recommended: "A", rationale: "r" }],
		["recommended", { candidates: CANDS, rationale: "r" }],
		["rationale", { candidates: CANDS, recommended: "A" }],
	])("a call without %s is refused naming it", (field, params) => {
		const out = candidateRequest(params, "Which?");
		expect((out as { refused: string }).refused).toContain(field);
	});
});
