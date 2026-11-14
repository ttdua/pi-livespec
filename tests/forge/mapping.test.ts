import { describe, expect, it } from "vitest";
import { overallState, toCheckState, toPermission, toReviewState } from "../../src/forge/mapping.ts";
import type { Check } from "../../src/forge/types.ts";

const check = (state: Check["state"]): Check => ({ name: state, state });

describe("forge mapping", () => {
	describe("overallState", () => {
		it("is none without checks", () => {
			expect(overallState([])).toBe("none");
		});

		it("is failure when any check failed, even with pending ones", () => {
			expect(overallState([check("success"), check("pending"), check("failure")])).toBe("failure");
		});

		it("is pending when nothing failed and something is pending", () => {
			expect(overallState([check("success"), check("pending")])).toBe("pending");
		});

		it("is success when every check succeeded", () => {
			expect(overallState([check("success"), check("success")])).toBe("success");
		});
	});

	describe("toCheckState", () => {
		it.each([
			["success", "success"],
			["failure", "failure"],
			["error", "failure"],
			["pending", "pending"],
			["warning", "pending"],
			[undefined, "pending"],
		])("maps status %s to %s", (status, expected) => {
			expect(toCheckState(status)).toBe(expected);
		});
	});

	describe("toReviewState", () => {
		it.each([
			["APPROVED", "approved"],
			["CHANGES_REQUESTED", "changes_requested"],
			["REQUEST_CHANGES", "changes_requested"],
			["COMMENTED", "commented"],
			["COMMENT", "commented"],
			["PENDING", "commented"],
			[undefined, "commented"],
		])("maps %s to %s", (state, expected) => {
			expect(toReviewState(state)).toBe(expected);
		});
	});

	describe("toPermission", () => {
		it.each([
			["owner", "admin"],
			["admin", "admin"],
			["maintain", "write"],
			["write", "write"],
			["triage", "read"],
			["read", "read"],
			["none", "none"],
			["bogus", "none"],
			[undefined, "none"],
		])("maps %s to %s", (level, expected) => {
			expect(toPermission(level)).toBe(expected);
		});
	});
});
