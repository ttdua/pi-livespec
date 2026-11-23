import { describe, expect, it } from "vitest";
import { parseInitiative } from "../../src/core/initiative.ts";
import { dependencyGraph, findCycle, formatCycle } from "../../src/initiatives/graph.ts";

describe("graph", () => {
	it("finds a two-node cycle", () => {
		expect(findCycle(new Map([[34, [35]], [35, [34]]]))).toEqual([34, 35, 34]);
	});
	it("finds a self dependency", () => {
		expect(findCycle(new Map([[7, [7]]]))).toEqual([7, 7]);
	});
	it("returns undefined when acyclic", () => {
		expect(findCycle(new Map([[1, [2]], [2, [3]], [3, []]]))).toBeUndefined();
	});
	it("formats cycles", () => {
		expect(formatCycle([34, 35, 34])).toBe("#34 → #35 → #34");
		expect(formatCycle(["a", "b", "a"])).toBe("a → b → a");
	});
	it("unions a change line with its entry", () => {
		const i = parseInitiative("## Changes\n- [ ] #35 x — Depends: #36\n");
		expect(dependencyGraph([{ number: 35, depends: [34] }], i).get(35)).toEqual([34, 36]);
	});
});
