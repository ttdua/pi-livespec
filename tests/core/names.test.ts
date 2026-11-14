import { describe, expect, it } from "vitest";
import { isKebabName } from "../../src/core/names.ts";

describe("isKebabName", () => {
	it("accepts kebab names", () => {
		expect(isKebabName("rate-limit")).toBe(true);
		expect(isKebabName("a1")).toBe(true);
	});
	it("rejects malformed names", () => {
		for (const s of ["-bad", "bad-", "bad--name", "Rate", ""]) expect(isKebabName(s)).toBe(false);
	});
});
