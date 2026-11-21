import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { pullRequestBody } from "../../src/ship/pr-body.ts";
import { FIXTURE_BODY, stateFor } from "../helpers/change-state.ts";

describe("pullRequestBody", () => {
	test("holds Proposal paragraph, units, durable docs, review and ends with Refs", () => {
		const { title, body } = pullRequestBody(stateFor("ship"), "Round 2 clean.");
		expect(title).toBe("per-ip-cap");
		expect(body).toContain("Limit each client IP.");
		expect(body).toContain("- [x] U1 — Request context");
		expect(body).toContain("- [ ] U3 — Rate limit per IP");
		expect(body).toContain("| specs/product.md | not needed — <reason> |");
		expect(body).toContain("Round 2 clean.");
		expect(body.endsWith("Refs #7")).toBe(true);
	});

	test.each([
		["Closes #12", "Refs #12"],
		["fixes owner/repo#12", "Refs owner/repo#12"],
		["Resolved: #3", "Refs #3"],
		["FIXED #4", "Refs #4"],
		["prefix #5", "prefix #5"],
	])("closing keyword %s", (input, expected) => {
		const text = FIXTURE_BODY.replace("Limit each client IP.", input);
		const { body } = pullRequestBody(stateFor("ship", { change: parseChange(text) }, text), "");
		expect(body).toContain(expected);
		expect(body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b\s*:?\s*#/i);
	});

	test("only the first Proposal paragraph is used", () => {
		const text = FIXTURE_BODY.replace("Limit each client IP.", "First.\n\nSecond.");
		const { body } = pullRequestBody(stateFor("ship", { change: parseChange(text) }, text), "");
		expect(body).toContain("First.");
		expect(body).not.toContain("Second.");
	});
});
