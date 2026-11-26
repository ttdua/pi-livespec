import { describe, expect, test } from "vitest";
import { candidateRequest } from "../../src/tools/question-candidates.ts";

describe("candidate labels", () => {
	test.each([["tab", "a\tb"], ["no-break space", "a\u00a0b"], ["ideographic space", "a\u3000b"]])("a %s inside a label is refused", (_n, label) => {
		const out = candidateRequest({ candidates: [{ label, description: "d" }, { label: "other", description: "d" }] }, "Which?");
		expect(out).toHaveProperty("refused");
	});

	test("a single ordinary space is accepted", () => {
		const out = candidateRequest({ candidates: [{ label: "per user", description: "d" }, { label: "per ip", description: "d" }] }, "Which?");
		expect(out).not.toHaveProperty("refused");
	});
});
