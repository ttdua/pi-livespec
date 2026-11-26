import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { ApprovalRequest, RequestOption } from "../../../src/interaction/approver.ts";
import { keyToAction } from "../../../src/interaction/dialog/keys.ts";
import { buildModel, type DialogModel } from "../../../src/interaction/dialog/model.ts";
import { type DialogState, initialState } from "../../../src/interaction/dialog/state.ts";

const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	backspace: "\x7f",
	kitty3: "\x1b[51u",
	kittyN: "\x1b[110u",
	kittyE: "\x1b[101u",
};

// Bindings from a table, so the tests prove the injected manager is used for its ids.
const TABLE: Record<string, string[]> = {
	"tui.select.up": [KEY.up],
	"tui.select.down": [KEY.down],
	"tui.select.confirm": [KEY.enter],
	"tui.select.cancel": [KEY.escape],
	"tui.select.pageUp": [KEY.pageUp],
	"tui.select.pageDown": [KEY.pageDown],
	"tui.input.submit": [KEY.enter],
};
const kb = { matches: (data: string, id: string) => TABLE[id]?.includes(data) ?? false } as unknown as KeybindingsManager;

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
	return {
		id: "gate-plan.abc",
		kind: "gate",
		subject: "gate:plan",
		record: { id: "gate-plan.abc", kind: "gate", subject: "gate:plan", mode: "blocking", head_sha: "d", snapshot: { target: "plan", failingWaivable: [] }, summary: "Approve plan?" },
		change: 7,
		phase: "plan",
		summary: "Approve plan?",
		links: [],
		files: [],
		mode: "blocking",
		...over,
	};
}

const OPTIONS: RequestOption[] = [{ id: "A", label: "Option A" }, { id: "B", label: "Option B" }];
const gate = (): DialogModel => buildModel(request());
const plan = (): DialogModel => buildModel(request({ overridable: { units: ["U1"], current: { U1: { difficulty: "low", tags: [] } } } }));
const stuck = (): DialogModel => buildModel(request({ kind: "stuck", subject: "stuck:S1", options: OPTIONS }));
const question = (): DialogModel =>
	buildModel(request({ kind: "question", subject: "question:Q1", options: OPTIONS, question: { id: "Q1", class: "blocking", requirements: ["r1"] } }));

const field = (text = "typed") => ({ value: () => text });
const at = (m: DialogModel, over: Partial<DialogState> = {}): DialogState => ({ ...initialState(m), ...over });
const key = (data: string, m: DialogModel, s: DialogState = at(m), f = field()) => keyToAction(data, kb, m, s, f);

describe("keyToAction without an editor", () => {
	test("up and down move", () => {
		expect(key(KEY.up, gate())).toEqual({ type: "move", delta: -1 });
		expect(key(KEY.down, gate())).toEqual({ type: "move", delta: 1 });
	});

	test("a digit picks entry n-1, also in the Kitty CSI-u encoding", () => {
		expect(key("3", gate())).toEqual({ type: "pick", index: 2 });
		expect(key(KEY.kitty3, gate())).toEqual({ type: "pick", index: 2 });
		expect(key("0", gate())).toBeUndefined();
	});

	test("n opens the note editor only when the model has notes", () => {
		expect(key("n", gate())).toEqual({ type: "openEditor", editor: "note" });
		expect(key("n", stuck())).toBeUndefined();
	});

	test("n and e also work Kitty CSI-u encoded", () => {
		const m = plan();
		expect(key(KEY.kittyN, m)).toEqual({ type: "openEditor", editor: "note" });
		expect(key(KEY.kittyE, m, at(m, { tab: 1 }))).toEqual({ type: "openEditor", editor: "tags" });
	});

	test("Tab and Shift+Tab switch tabs", () => {
		expect(key(KEY.tab, gate())).toEqual({ type: "nextTab" });
		expect(key(KEY.shiftTab, gate())).toEqual({ type: "previousTab" });
	});

	test("Enter picks on decision, submits on review, moves on from units", () => {
		const m = plan();
		expect(key(KEY.enter, m)).toEqual({ type: "pick" });
		expect(key(KEY.enter, m, at(m, { tab: 1 }))).toEqual({ type: "nextTab" });
		expect(key(KEY.enter, m, at(m, { tab: 2 }))).toEqual({ type: "submit" });
	});

	test("Esc cancels", () => {
		expect(key(KEY.escape, gate())).toEqual({ type: "cancel" });
	});

	test("PageUp and PageDown scroll", () => {
		expect(key(KEY.pageUp, gate())).toEqual({ type: "scroll", delta: -5 });
		expect(key(KEY.pageDown, gate())).toEqual({ type: "scroll", delta: 5 });
	});

	test("left and right cycle difficulty on the units tab only", () => {
		const m = plan();
		expect(key(KEY.right, m, at(m, { tab: 1 }))).toEqual({ type: "cycleDifficulty", delta: 1 });
		expect(key(KEY.left, m, at(m, { tab: 1 }))).toEqual({ type: "cycleDifficulty", delta: -1 });
		expect(key(KEY.right, m)).toBeUndefined();
	});

	test("e opens the tags editor on the units tab only", () => {
		const m = plan();
		expect(key("e", m, at(m, { tab: 1 }))).toEqual({ type: "openEditor", editor: "tags" });
		expect(key("e", m)).toBeUndefined();
	});

	test("question review: digits pick a requirement, Enter picks the focused one, then submits", () => {
		const m = question();
		const review = at(m, { tab: 1 });
		expect(key("2", m, review)).toEqual({ type: "pickRequirement", index: 1 });
		expect(key(KEY.enter, m, { ...review, focus: 1 })).toEqual({ type: "pickRequirement", index: 1 });
		expect(key(KEY.enter, m, { ...review, focus: 1, requirement: { kind: "named", name: "r1" } })).toEqual({ type: "submit" });
		expect(key(KEY.enter, m, { ...review, focus: 0, requirement: { kind: "none" } })).toEqual({ type: "submit" });
		expect(key(KEY.enter, m, { ...review, focus: 2, requirement: { kind: "other", text: "x" } })).toEqual({ type: "submit" });
	});

	test("unknown keys do nothing", () => {
		expect(key("z", gate())).toBeUndefined();
	});
});

describe("keyToAction with an editor open", () => {
	const open = (m: DialogModel) => at(m, { editor: "note" });

	test("printable keys, digits and Backspace are forwarded to the field", () => {
		const m = gate();
		for (const data of ["n", "3", KEY.kitty3, KEY.backspace, KEY.tab, KEY.up]) expect(key(data, m, open(m))).toBeUndefined();
	});

	test("submit closes the editor with the field's text", () => {
		const m = gate();
		expect(key(KEY.enter, m, open(m), field("tighten wording"))).toEqual({ type: "closeEditor", text: "tighten wording" });
	});

	test("Esc cancels (the reducer closes the editor only)", () => {
		const m = gate();
		expect(key(KEY.escape, m, open(m))).toEqual({ type: "cancel" });
	});
});
