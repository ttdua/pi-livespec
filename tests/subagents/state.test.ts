// Tests of the lane records and the unit worktree resolution.
import { describe, expect, it } from "vitest";
import { type MarkedComment, parseMarked } from "../../src/forge/markers.ts";
import { invalidLanes, laneComment, openLanes, unitRoot } from "../../src/subagents/state.ts";
import { stateFor } from "../helpers/change-state.ts";

let n = 0;
const mark = (body: string): MarkedComment => {
	const p = parseMarked(body);
	if (!p) throw new Error("not marked");
	return { commentId: `c${++n}`, kind: p.kind, id: p.id, author: "me", data: p.data };
};
const lane = { unit: "U2", path: "/w/.worktrees/x--U2", branch: "livespec/x--lane-U2", base: "abc" };

describe("lanes", () => {
	it("lane record open and closed", () => {
		const open = mark(laneComment(lane));
		expect(openLanes([open])).toEqual({ U2: lane });
		expect(openLanes([open, mark(laneComment({ ...lane, closed: true }))])).toEqual({});
	});

	it("unitRoot returns the open lane, else the change root", () => {
		const state = stateFor("apply", { subagents: { executor: { ok: true, missing: [] }, turnsCompleted: 0, lanes: { U2: lane } } });
		expect(unitRoot(state, "U2", "/w")).toBe(lane.path);
		expect(unitRoot(state, "U1", "/w")).toBe("/w");
	});
});

describe("lane validation", () => {
	it("a null or incomplete lane record is skipped", () => {
		const m = (data: unknown): MarkedComment => ({ commentId: "x", kind: "lane", id: "lane.U9", author: "me", data });
		expect(openLanes([m(null), m({ unit: "U9" }), mark(laneComment(lane))])).toEqual({ U2: lane });
	});
});

describe("lane closed flag", () => {
	it('closed: "true" is invalid, not an open lane', () => {
		const m: MarkedComment = { commentId: "x", kind: "lane", id: "lane.U2", author: "me", data: { ...lane, closed: "true" } };
		expect(openLanes([m])).toEqual({});
		expect(invalidLanes([m])).toHaveLength(1);
	});
});
