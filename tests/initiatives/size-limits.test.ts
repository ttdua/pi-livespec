import { describe, expect, test } from "vitest";
import { registerBuiltinChecks } from "../../src/engine/checks.ts";
import { getCheck, isWaivable } from "../../src/engine/registry.ts";
import type { Git } from "../../src/engine/git.ts";
import { sizeLimitResults } from "../../src/initiatives/size-limits.ts";
import { sizedChange } from "./fixture.ts";

const LIMITS = { max_units: 8, max_capabilities: 3 };

describe("size-limits", () => {
	test("too many units is one error", () => {
		expect(sizeLimitResults(sizedChange(1, 9), LIMITS)).toEqual([{ code: "size-limits", severity: "error", section: "Units", message: "9 units exceed max_units 8" }]);
	});

	test("too many capabilities is one error", () => {
		expect(sizeLimitResults(sizedChange(4, 1), LIMITS)).toEqual([{ code: "size-limits", severity: "error", section: "Capabilities", message: "4 capabilities exceed max_capabilities 3" }]);
	});

	test("within the limits", () => {
		expect(sizeLimitResults(sizedChange(3, 8), LIMITS)).toEqual([]);
	});

	test("no limits never fails", () => {
		expect(sizeLimitResults(sizedChange(9, 20), undefined)).toEqual([]);
		expect(sizeLimitResults(sizedChange(9, 20), {})).toEqual([]);
	});

	test("is a registered waivable check that reads ctx.limits", async () => {
		registerBuiltinChecks();
		expect(isWaivable("size-limits")).toBe(true);
		const check = getCheck("size-limits");
		const results = await check?.({ root: "/nowhere", change: sizedChange(1, 9), git: {} as Git, marked: [], limits: LIMITS });
		expect(results?.map((r) => r.message)).toEqual(["9 units exceed max_units 8"]);
	});
});
