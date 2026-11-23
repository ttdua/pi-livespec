import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { closingReferences, neutralizeClosing, pullRequestBody } from "../../src/ship/pr-body.ts";
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

	test.each([
		["fixes #1, #2", "Refs #1, #2"],
		["closes #1 and resolves #2", "Refs #1 and Refs #2"],
		["fixes owner/repo#1, owner/repo#2", "Refs owner/repo#1, owner/repo#2"],
	])("comma-separated or repeated closing refs %s", (input, expected) => {
		const text = FIXTURE_BODY.replace("Limit each client IP.", input);
		const { body } = pullRequestBody(stateFor("ship", { change: parseChange(text) }, text), "");
		expect(body).toContain(expected);
	});

	test("closing keywords in the review text and Durable docs are rewritten too", () => {
		const text = FIXTURE_BODY.replace("| specs/product.md | not needed — <reason> |", "| specs/product.md | updated, closes #9 |");
		const { body } = pullRequestBody(stateFor("ship", { change: parseChange(text) }, text), "Fixed #8 in round 2.");
		expect(body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b\s*:?\s*#/i);
		expect(body).toContain("Refs #8");
		expect(body).toContain("Refs #9");
	});

	test.each([
		["closes https://github.com/ttdua/pi-livespec/issues/32", "Refs https://github.com/ttdua/pi-livespec/issues/32"],
		["Fixes: http://git.example.com/o/r/issues/7.", "Refs http://git.example.com/o/r/issues/7."],
	])("closing keyword before an issue URL %s", (input, expected) => {
		expect(neutralizeClosing(input)).toBe(expected);
	});

	test("closingReferences lists every closing phrase, by short ref and by URL", () => {
		expect(closingReferences("wip\n\nFixes #7 and resolves https://github.com/o/r/issues/8")).toEqual(["Fixes #7", "resolves https://github.com/o/r/issues/8"]);
		expect(closingReferences("Refs #7, see https://github.com/o/r/pull/8")).toEqual([]);
	});

	test("a bare owner/repo# without a number is left alone", () => {
		const text = FIXTURE_BODY.replace("Limit each client IP.", "fixes owner/repo# later");
		const { body } = pullRequestBody(stateFor("ship", { change: parseChange(text) }, text), "");
		expect(body).toContain("fixes owner/repo# later");
	});
});
