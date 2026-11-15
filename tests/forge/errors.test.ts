import { describe, expect, test } from "vitest";
import { ForgeError, type ForgeErrorCode, isOffline, isUnreachable } from "../../src/forge/errors.ts";

const err = (code: ForgeErrorCode) => new ForgeError({ code, operation: "op", message: "m" });

describe("forge error predicates", () => {
	test("isUnreachable is true only for an unreachable ForgeError", () => {
		expect(isUnreachable(err("unreachable"))).toBe(true);
		for (const code of ["readonly", "auth", "http", "unsupported"] as const) expect(isUnreachable(err(code))).toBe(false);
		expect(isUnreachable(new Error("unreachable"))).toBe(false);
	});

	test("isOffline is true for an unreachable or read-only ForgeError", () => {
		expect(isOffline(err("unreachable"))).toBe(true);
		expect(isOffline(err("readonly"))).toBe(true);
		for (const code of ["auth", "http", "unsupported"] as const) expect(isOffline(err(code))).toBe(false);
		expect(isOffline("readonly")).toBe(false);
	});
});
