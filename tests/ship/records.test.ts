import { describe, expect, test } from "vitest";
import { parseMarked } from "../../src/forge/markers.ts";
import { latestShipRecord, shipComment } from "../../src/ship/records.ts";

function marked(pr: number, pushedHead: string) {
	const body = shipComment({ pr, pushedHead, confirmed: ["x"] });
	const m = parseMarked(body)!;
	return { commentId: "c", kind: m.kind, id: m.id, author: "me", data: m.data };
}

describe("ship records", () => {
	test("the ship kind is registered and the id is ship.<pr>.<head>", () => {
		const body = shipComment({ pr: 4, pushedHead: "abc", confirmed: [] });
		expect(body.startsWith("<!-- livespec:ship:ship.4.abc -->")).toBe(true);
	});
	test("latestShipRecord returns the last record", () => {
		expect(latestShipRecord([marked(4, "a"), marked(4, "b")])).toEqual({ pr: 4, pushedHead: "b", confirmed: ["x"] });
		expect(latestShipRecord([])).toBeUndefined();
	});
});
