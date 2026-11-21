import { describe, expect, test } from "vitest";
import { parseMarked, writeMarked } from "../../src/forge/markers.ts";
import { staleComment } from "../../src/interaction/stale.ts";

describe("staleComment", () => {
	test("parses back as a stale marker with its phases", () => {
		const parsed = parseMarked(staleComment("stale.x", { reason: "r", phases: ["ship"] }));
		expect(parsed).toEqual({ kind: "stale", id: "stale.x", data: { reason: "r", phases: ["ship"], units: [], after_plan: false } });
	});

	test("carries the units it is given", () => {
		const parsed = parseMarked(staleComment("s1", { reason: "r", phases: ["review", "ship"], units: ["U2"] }));
		expect(parsed?.data).toMatchObject({ phases: ["review", "ship"], units: ["U2"] });
	});

	test("writes the same bytes as the gate cascade did before the extraction", () => {
		const before = writeMarked("stale", "gate-define.1", { reason: "define changes requested", phases: ["plan", "build"], units: [], after_plan: false });
		expect(staleComment("gate-define.1", { reason: "define changes requested", phases: ["plan", "build"] })).toBe(before);
	});
});
