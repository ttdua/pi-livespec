import { describe, expect, test } from "vitest";
import type { ApprovalRequest, RequestOption } from "../../../src/interaction/approver.ts";
import { buildModel, type DialogModel } from "../../../src/interaction/dialog/model.ts";
import { canSubmit, type DialogAction, type DialogState, initialState, reduce } from "../../../src/interaction/dialog/state.ts";

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
const plan = (): DialogModel => buildModel(request({ overridable: { units: ["U1", "U2"], current: { U1: { difficulty: "low", tags: ["a"] } } } }));
const question = (): DialogModel =>
	buildModel(request({ kind: "question", subject: "question:Q1", options: OPTIONS, question: { id: "Q1", class: "blocking", requirements: ["r1", "r2"] } }));

function run(model: DialogModel, actions: DialogAction[], from: DialogState = initialState(model)): DialogState {
	return actions.reduce((s, a) => reduce(model, s, a), from);
}

const review = (m: DialogModel): DialogState => ({ ...initialState(m), tab: m.tabs.length - 1 });

const deepFreeze = <T>(o: T): T => {
	if (typeof o === "object" && o !== null) Object.values(o).forEach(deepFreeze);
	return Object.freeze(o);
};

describe("move and scroll and tabs", () => {
	test("move wraps within entries", () => {
		const m = gate();
		expect(run(m, [{ type: "move", delta: -1 }]).focus).toBe(2);
		expect(run(m, [{ type: "move", delta: 1 }, { type: "move", delta: 1 }, { type: "move", delta: 1 }]).focus).toBe(0);
	});

	test("scroll clamps at 0", () => {
		const m = gate();
		expect(run(m, [{ type: "scroll", delta: -5 }]).scroll).toBe(0);
		expect(run(m, [{ type: "scroll", delta: 3 }, { type: "scroll", delta: -1 }]).scroll).toBe(2);
	});

	test("nextTab and previousTab wrap", () => {
		const m = plan();
		expect(run(m, [{ type: "previousTab" }]).tab).toBe(2);
		expect(run(m, [{ type: "nextTab" }, { type: "nextTab" }, { type: "nextTab" }]).tab).toBe(0);
	});
});

describe("pick", () => {
	test("pick with an index selects entry n; a gate entry moves to the next tab", () => {
		const m = gate();
		const s = run(m, [{ type: "pick", index: 0 }]);
		expect(s.picked).toBe(0);
		expect(s.tab).toBe(1);
		expect(s.done).toBeUndefined();
	});

	test("pick without an index uses the focused row", () => {
		const m = gate();
		expect(run(m, [{ type: "move", delta: 1 }, { type: "pick" }]).picked).toBe(1);
	});

	test("pick changes with an empty note opens the note editor", () => {
		const s = run(gate(), [{ type: "pick", index: 1 }]);
		expect(s.editor).toBe("note");
		expect(s.tab).toBe(0);
	});

	test("pick changes with a note moves on", () => {
		const m = gate();
		const s = run(m, [{ type: "pick", index: 1 }], { ...initialState(m), notes: "n" });
		expect(s.editor).toBeUndefined();
		expect(s.tab).toBe(1);
	});

	test("pick later is deferred at once", () => {
		const m = question();
		const later = m.entries.findIndex((e) => e.action.kind === "later");
		expect(run(m, [{ type: "pick", index: later }]).done).toBe("deferred");
	});

	test("pick dismiss is cancelled", () => {
		expect(run(gate(), [{ type: "pick", index: 2 }]).done).toBe("cancelled");
	});

	test("pick own opens the answer editor", () => {
		const m = question();
		const own = m.entries.findIndex((e) => e.action.kind === "own");
		expect(run(m, [{ type: "pick", index: own }]).editor).toBe("answer");
	});

	test("pick own with an answer already typed moves on", () => {
		const m = question();
		const own = m.entries.findIndex((e) => e.action.kind === "own");
		const s = run(m, [{ type: "pick", index: own }], { ...initialState(m), answer: "x" });
		expect(s.editor).toBeUndefined();
		expect(m.tabs[s.tab]).toBe("review");
	});

	test("pick outside the decision tab does nothing", () => {
		const m = gate();
		const s = run(m, [{ type: "nextTab" }]);
		expect(run(m, [{ type: "pick", index: 0 }], s)).toEqual(s);
	});
});

describe("submit and canSubmit", () => {
	test("blank note blocks submit", () => {
		const m = gate();
		const s: DialogState = { ...initialState(m), picked: 1, notes: "  ", tab: 1 };
		expect(canSubmit(m, s)).toMatchObject({ ok: false });
		const after = reduce(m, s, { type: "submit" });
		expect(after.done).toBeUndefined();
		expect(after.error).toBeDefined();
	});

	test("opening an editor clears a stale submit error", () => {
		const m = gate();
		const s: DialogState = { ...initialState(m), picked: 1, notes: "", tab: 1, error: "A note is required" };
		expect(reduce(m, s, { type: "openEditor", editor: "note" }).error).toBeUndefined();
	});

	test("submit only on the review tab", () => {
		const m = gate();
		const s: DialogState = { ...initialState(m), picked: 0 };
		expect(reduce(m, s, { type: "submit" }).done).toBeUndefined();
		expect(reduce(m, { ...s, tab: 1 }, { type: "submit" }).done).toBe("submitted");
	});

	test("nothing picked is not submittable", () => {
		const m = gate();
		expect(canSubmit(m, initialState(m)).ok).toBe(false);
	});

	test("question needs a requirement pick, a typed answer and a typed requirement", () => {
		const m = question();
		const own = m.entries.findIndex((e) => e.action.kind === "own");
		const cand: DialogState = { ...initialState(m), picked: 0 };
		expect(canSubmit(m, cand).ok).toBe(false);
		expect(canSubmit(m, { ...cand, requirement: { kind: "none" } }).ok).toBe(true);
		const typed: DialogState = { ...initialState(m), picked: own, requirement: { kind: "none" } };
		expect(canSubmit(m, typed).ok).toBe(false);
		expect(canSubmit(m, { ...typed, answer: "x" }).ok).toBe(true);
		expect(canSubmit(m, { ...typed, answer: "x", requirement: { kind: "other", text: " " } }).ok).toBe(false);
	});

	test("pickRequirement sets none and named; other opens the editor", () => {
		const m = question();
		expect(run(m, [{ type: "pickRequirement", index: 0 }], review(m)).requirement).toEqual({ kind: "none" });
		expect(run(m, [{ type: "pickRequirement", index: 2 }], review(m)).requirement).toEqual({ kind: "named", name: "r2" });
		const other = run(m, [{ type: "pickRequirement", index: 3 }], review(m));
		expect(other.requirement).toEqual({ kind: "other", text: "" });
		expect(other.editor).toBe("requirement");
	});

	test("Review shows the answer before it is sent", () => {
		const m = buildModel(request({ options: [{ id: "waive", label: "Waive x" }], record: { ...request().record, snapshot: { target: "plan", failingWaivable: ["x"] } } }));
		const waive = m.entries.findIndex((e) => e.action.kind === "option");
		const s = run(m, [{ type: "pick", index: waive }]);
		expect(m.tabs[s.tab]).toBe("review");
		expect(s.done).toBeUndefined();
		expect(m.entries[s.picked as number]?.action).toEqual({ kind: "option", id: "waive" });
	});

	test("review state keeps overrides when changes is picked, so the view can list them as discarded", () => {
		const m = plan();
		const s = run(m, [{ type: "nextTab" }, { type: "cycleDifficulty", delta: 1 }, { type: "previousTab" }, { type: "pick", index: 1 }], { ...initialState(m), notes: "n" });
		expect(s.overrides.U1?.difficulty).toBe("medium");
		expect(m.tabs[s.tab]).toBe("units");
	});
});

describe("cancel and editor", () => {
	test("cancel with no editor", () => {
		expect(run(gate(), [{ type: "cancel" }]).done).toBe("cancelled");
	});

	test("Esc in the note editor", () => {
		const m = gate();
		const s = run(m, [{ type: "cancel" }], { ...initialState(m), editor: "note", notes: "keep" });
		expect(s.editor).toBeUndefined();
		expect(s.done).toBeUndefined();
		expect(s.notes).toBe("keep");
	});

	test("closeEditor stores the text in the open editor's field", () => {
		const m = gate();
		expect(run(m, [{ type: "closeEditor", text: "hi" }], { ...initialState(m), editor: "note" })).toMatchObject({ notes: "hi", editor: undefined });
		expect(run(m, [{ type: "closeEditor", text: "ans" }], { ...initialState(m), editor: "answer" }).answer).toBe("ans");
		expect(run(m, [{ type: "closeEditor", text: "req" }], { ...initialState(m), editor: "requirement" }).requirement).toEqual({ kind: "other", text: "req" });
	});

	test("closeEditor on tags parses a, b", () => {
		const m = plan();
		const s = run(m, [{ type: "nextTab" }, { type: "openEditor", editor: "tags" }, { type: "closeEditor", text: "a, b ,, " }]);
		expect(s.overrides.U1?.tags).toEqual(["a", "b"]);
	});
});

describe("cycleDifficulty", () => {
	test("from undefined: low, then low → medium → high → low", () => {
		const m = plan();
		const toU2: DialogAction[] = [{ type: "nextTab" }, { type: "move", delta: 1 }];
		const levels = [1, 2, 3, 4].map((n) => run(m, [...toU2, ...Array.from({ length: n }, () => ({ type: "cycleDifficulty", delta: 1 }) as DialogAction)]).overrides.U2?.difficulty);
		expect(levels).toEqual(["low", "medium", "high", "low"]);
	});

	test("from a current value", () => {
		const m = plan();
		expect(run(m, [{ type: "nextTab" }, { type: "cycleDifficulty", delta: 1 }]).overrides.U1?.difficulty).toBe("medium");
		expect(run(m, [{ type: "nextTab" }, { type: "cycleDifficulty", delta: -1 }]).overrides.U1?.difficulty).toBe("high");
	});

	test("delta -1 from undefined: high", () => {
		const m = plan();
		const s = run(m, [{ type: "nextTab" }, { type: "move", delta: 1 }, { type: "cycleDifficulty", delta: -1 }]);
		expect(s.overrides.U2?.difficulty).toBe("high");
	});

	test("only on the units tab", () => {
		const m = plan();
		expect(run(m, [{ type: "cycleDifficulty", delta: 1 }]).overrides).toEqual({});
	});
});

describe("reducer guards", () => {
	test("openEditor tags only on the units tab", () => {
		const m = plan();
		const s = initialState(m);
		expect(reduce(m, s, { type: "openEditor", editor: "tags" })).toEqual(s);
	});

	test("closeEditor tags only on the units tab", () => {
		const m = plan();
		const s: DialogState = { ...initialState(m), editor: "tags" };
		expect(reduce(m, s, { type: "closeEditor", text: "a" })).toEqual(s);
	});

	test("pickRequirement only on the review tab", () => {
		const m = question();
		const s = initialState(m);
		expect(reduce(m, s, { type: "pickRequirement", index: 0 })).toEqual(s);
	});

	test("openEditor note only when the model has notes", () => {
		const m = question();
		const s = initialState(m);
		expect(reduce(m, s, { type: "openEditor", editor: "note" })).toEqual(s);
	});

	test("re-picking other keeps the typed text", () => {
		const m = question();
		const s = run(m, [{ type: "pickRequirement", index: 3 }], { ...initialState(m), tab: 1, requirement: { kind: "other", text: "typed" } });
		expect(s.requirement).toEqual({ kind: "other", text: "typed" });
	});
});

describe("purity", () => {
	test("state never mutated", () => {
		const m = plan();
		const actions: DialogAction[] = [
			{ type: "move", delta: 1 },
			{ type: "scroll", delta: 2 },
			{ type: "pick", index: 0 },
			{ type: "nextTab" },
			{ type: "cycleDifficulty", delta: 1 },
			{ type: "openEditor", editor: "tags" },
			{ type: "closeEditor", text: "z" },
			{ type: "previousTab" },
			{ type: "submit" },
			{ type: "cancel" },
		];
		let s: DialogState = deepFreeze({ ...initialState(m), overrides: deepFreeze({ U1: { tags: ["a"] } }) });
		for (const a of actions) s = deepFreeze(reduce(m, s, a));
		expect(s.done).toBe("cancelled");
	});
});
