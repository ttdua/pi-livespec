import { describe, expect, test } from "vitest";
import { closeRefusal, initiativeNumber } from "../../src/ship/close.ts";
import { stateFor } from "../helpers/change-state.ts";

const pr = (o: object) => ({ number: 41, state: "open" as const, merged: false, ...o });

describe("closeRefusal", () => {
	test("merged pull request in close passes", () => {
		expect(closeRefusal(stateFor("close", { pr: pr({ state: "closed", merged: true }) }), undefined)).toBeUndefined();
	});
	test("an open pull request refuses", () => {
		expect(closeRefusal(stateFor("close", { pr: pr({}) }), undefined)).toContain("not merged");
	});
	test("another phase refuses", () => {
		expect(closeRefusal(stateFor("ship", { pr: pr({ merged: true, state: "closed" }) }), undefined)).toContain("ship");
	});
	test("abandon needs a reason and a closed unmerged pull request", () => {
		const closed = stateFor("ship", { pr: pr({ state: "closed" }) });
		expect(closeRefusal(closed, " ")).toContain("empty");
		expect(closeRefusal(closed, "why")).toBeUndefined();
		expect(closeRefusal(stateFor("ship", { pr: pr({}) }), "why")).toContain("not closed");
		expect(closeRefusal(stateFor("ship", { pr: pr({ state: "closed", merged: true }) }), "why")).toContain("not closed");
	});
});

describe("initiativeNumber", () => {
	test("reads #N", () => {
		expect(initiativeNumber({ initiative: "#30" } as never)).toBe(30);
		expect(initiativeNumber({} as never)).toBeUndefined();
	});
});
