import { describe, expect, test } from "vitest";
import { reconcileIncomplete, startedItem } from "../../src/engine/incomplete-items.ts";

describe("reconcileIncomplete", () => {
	test("drops a started item whose unit is no longer started", () => {
		expect(reconcileIncomplete(["U2 is started", "U3 is started", "uncommitted changes in the working tree"], { U3: {} })).toEqual(["U3 is started", "uncommitted changes in the working tree"]);
	});

	test("keeps a started item whose unit is started", () => {
		expect(reconcileIncomplete(["U2 is started"], { U2: {} })).toEqual(["U2 is started"]);
	});

	test("keeps foreign item texts as recorded", () => {
		expect(reconcileIncomplete(["review pending for U2", "U2 started"], {})).toEqual(["review pending for U2", "U2 started"]);
	});

	test("drops an item for an id that is not a started unit", () => {
		expect(reconcileIncomplete(["x is started"], {})).toEqual([]);
	});
});

test("startedItem is the started-unit item text", () => {
	expect(startedItem("U2")).toBe("U2 is started");
});
