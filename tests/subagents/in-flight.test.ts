// Tests of the in-flight registry: one claim per target key.
import { afterEach, describe, expect, test } from "vitest";
import { claim, clearInFlight, release, targetKey, update } from "../../src/subagents/in-flight.ts";

afterEach(clearInFlight);

describe("in-flight registry", () => {
	test("claim, update and release", () => {
		const k = targetKey(1, { role: "implementer", unit: "U1" });
		expect(claim(k)).toBeUndefined();
		expect(claim(k)).toBe("(launching)");
		update(k, "agent-1");
		expect(claim(k)).toBe("agent-1");
		release(k);
		expect(claim(k)).toBeUndefined();
	});

	test("keys differ by issue, subject and finding", () => {
		const base = { role: "reviewer" as const, unit: "U1" };
		const keys = [targetKey(1, base), targetKey(2, base), targetKey(1, { ...base, subject: "unit" }), targetKey(1, { ...base, subject: "spec" }), targetKey(1, { ...base, subject: "unit", finding: "F1" })];
		expect(new Set(keys).size).toBe(keys.length);
	});
});
