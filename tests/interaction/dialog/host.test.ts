import { type Component, type Focusable, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { ApprovalRequest, RequestOption } from "../../../src/interaction/approver.ts";
import { createDialog, type TextField } from "../../../src/interaction/dialog/host.ts";
import type { DialogOutcome } from "../../../src/interaction/dialog/types.ts";
import { FakeField, identityTheme, KEY, KEY_TABLE, stubKeybindings } from "../../helpers/dialog.ts";

const TABLE = KEY_TABLE;
const kb = stubKeybindings;
const theme = identityTheme;

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
	return {
		id: "gate-define.abc",
		kind: "gate",
		subject: "gate:define",
		record: { id: "gate-define.abc", kind: "gate", subject: "gate:define", mode: "blocking", head_sha: "d", snapshot: { target: "define", failingWaivable: [] }, summary: "Approve define?" },
		change: 7,
		phase: "define",
		summary: "Approve define?",
		links: [],
		files: [],
		mode: "blocking",
		...over,
	};
}

const OPTIONS: RequestOption[] = [{ id: "A", label: "Option A" }, { id: "B", label: "Option B" }];

function mount(r: ApprovalRequest, rows = 30, field: TextField | undefined = new FakeField(), makeField?: () => TextField) {
	const tui = { requestRender: vi.fn(), terminal: { rows } } as unknown as TUI;
	const done = vi.fn<(o: DialogOutcome) => void>();
	const factory = field === undefined ? createDialog(r) : createDialog(r, makeField ?? (() => field));
	const component = factory(tui, theme, kb, done) as Component & Focusable;
	const press = (...keys: string[]) => keys.forEach((k) => component.handleInput?.(k));
	return { tui, done, component, press, field: field as FakeField };
}

describe("createDialog", () => {
	test("define gate: Enter, Enter → done once with approved", () => {
		const { done, press, tui } = mount(request());
		press(KEY.enter);
		expect(done).not.toHaveBeenCalled();
		press(KEY.enter);
		expect(done).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledWith({ kind: "result", result: { outcome: "approved", notes: "" } });
		expect(tui.requestRender).toHaveBeenCalled();
		press(KEY.escape, KEY.enter);
		expect(done).toHaveBeenCalledTimes(1);
	});

	test("note: n, o, k forwarded to the field, submit, Enter, Enter → approved_with_notes ok", () => {
		const { done, press, field } = mount(request());
		press("n", "o", "k");
		expect(field.received).toEqual(["o", "k"]);
		press(KEY.enter, KEY.enter, KEY.enter);
		expect(done).toHaveBeenCalledWith({ kind: "result", result: { outcome: "approved_with_notes", notes: "ok" } });
	});

	test("backspace and a multi-line paste go to the field, not the reducer", () => {
		const { done, press, field, component } = mount(request());
		press("n", "x", KEY.backspace, "a\nb\r\nc", "2");
		expect(field.received).toEqual(["x", KEY.backspace, "a\nb\r\nc", "2"]);
		expect(field.text).toBe("a\nb\r\nc2");
		expect(component.render(80).join("\n")).toContain("Note:");
		expect(done).not.toHaveBeenCalled();
	});

	test("the field is prefilled with the stored text when an editor opens", () => {
		const { press, field } = mount(request());
		press("n", "o", "k", KEY.enter, "n");
		expect(field.sets).toEqual(["", "ok"]);
	});

	test("changes with an empty note: editor opens, empty submit closes it, Review blocks submit", () => {
		const { done, press, component } = mount(request());
		press("2");
		expect(component.render(80).join("\n")).toContain("[]");
		press(KEY.enter, KEY.tab, KEY.enter);
		expect(done).not.toHaveBeenCalled();
		expect(component.render(80)).toContain("! Requested changes need a note");
	});

	test("Esc cancels with an explicit marker", () => {
		const { done, press } = mount(request());
		press(KEY.escape);
		expect(done).toHaveBeenCalledWith({ kind: "cancelled" });
	});

	test("Esc cancels the dialog: a stuck request", () => {
		const { done, press } = mount(request({ kind: "stuck", subject: "stuck:S1", options: OPTIONS }));
		press(KEY.escape);
		expect(done).toHaveBeenCalledWith({ kind: "cancelled" });
	});

	test("Esc in the note editor only closes it", () => {
		const { done, press, component } = mount(request());
		press("n", KEY.escape);
		expect(done).not.toHaveBeenCalled();
		expect(component.render(80)).toContain("Note: — (n: add)");
	});

	test("dismiss → cancelled", () => {
		const { done, press } = mount(request());
		press("3");
		expect(done).toHaveBeenCalledWith({ kind: "cancelled" });
	});

	test("question answer later → deferred without review", () => {
		const r = request({ kind: "question", subject: "question:Q1", question: { id: "Q1", class: "blocking", requirements: [] } });
		const { done, press } = mount(r);
		press("2");
		expect(done).toHaveBeenCalledWith({ kind: "result", result: { status: "deferred", questionClass: "non-blocking" } });
	});

	test("own answer typed and no requirement change", () => {
		const r = request({ kind: "question", subject: "question:Q1", question: { id: "Q1", class: "blocking", requirements: [] } });
		const { done, press } = mount(r);
		press("1", "n", "o", " ", "l", "i", "m", "i", "t", KEY.enter, KEY.enter, KEY.enter, KEY.enter);
		expect(done).toHaveBeenCalledWith({ kind: "result", result: { outcome: "approved", notes: "", answer: "no limit", questionClass: "blocking" } });
	});

	test("plan gate: tags prefilled with the current tags; unchanged → no override", () => {
		const r = request({ subject: "gate:plan", overridable: { units: ["U1"], current: { U1: { difficulty: "low", tags: ["a", "b"] } } } });
		const { done, press, field } = mount(r);
		press(KEY.tab, "e");
		expect(field.sets).toEqual(["a, b"]);
		press(KEY.enter, KEY.right, KEY.right, KEY.tab, KEY.tab, "1", KEY.enter, KEY.enter);
		expect(done).toHaveBeenCalledWith({ kind: "result", result: { outcome: "approved", notes: "", overrides: [{ unit: "U1", difficulty: "high" }] } });
	});

	test("no field is made until an editor opens", () => {
		const makeField = vi.fn(() => new FakeField());
		const { press, component } = mount(request(), 30, new FakeField(), makeField);
		press(KEY.down, KEY.tab, "z", KEY.tab);
		component.render(80);
		component.invalidate();
		expect(makeField).not.toHaveBeenCalled();
		press("n");
		expect(makeField).toHaveBeenCalledTimes(1);
	});

	test("invalidate is forwarded to the field", () => {
		const { press, component, field } = mount(request());
		press("n");
		component.invalidate();
		expect(field.invalidated).toBe(1);
	});

	test("scroll is bounded: many PgDn then one PgUp moves the body; units tab stays at the top", () => {
		const summary = Array.from({ length: 60 }, (_, i) => `fact ${i + 1}`).join("\n");
		const PAGE_DOWN = "\x1b[6~";
		const PAGE_UP = "\x1b[5~";
		TABLE["tui.select.pageDown"] = [PAGE_DOWN];
		TABLE["tui.select.pageUp"] = [PAGE_UP];
		try {
			const { press, component } = mount(request({ summary }), 30);
			component.render(80);
			press(...Array.from({ length: 40 }, () => PAGE_DOWN));
			const firstFact = () => component.render(80).find((l) => /^fact \d+$/.test(l));
			const bottom = firstFact();
			press(PAGE_UP);
			expect(firstFact()).not.toBe(bottom);
		} finally {
			delete TABLE["tui.select.pageDown"];
			delete TABLE["tui.select.pageUp"];
		}
	});

	test("after the terminal widens, one PgUp still moves the body", () => {
		const summary = Array.from({ length: 40 }, (_, i) => `fact ${i + 1} ${"x".repeat(90)}`).join("\n");
		const PAGE_DOWN = "\x1b[6~";
		const PAGE_UP = "\x1b[5~";
		TABLE["tui.select.pageDown"] = [PAGE_DOWN];
		TABLE["tui.select.pageUp"] = [PAGE_UP];
		try {
			const { press, component } = mount(request({ summary }), 30);
			component.render(60);
			press(...Array.from({ length: 40 }, () => PAGE_DOWN));
			const firstFact = () => component.render(200).find((l) => /^fact \d+ /.test(l));
			const before = firstFact();
			press(PAGE_UP);
			expect(firstFact()).not.toBe(before);
		} finally {
			delete TABLE["tui.select.pageDown"];
			delete TABLE["tui.select.pageUp"];
		}
	});

	test("Ctrl+C in an editor only closes the editor", () => {
		const { done, press, component } = mount(request());
		press("n", "x", "\x03");
		expect(done).not.toHaveBeenCalled();
		expect(component.render(80)).not.toContain("[x]");
	});

	test("tags with blanks in the current values: submitting them unchanged is no override", () => {
		const r = request({ subject: "gate:plan", overridable: { units: ["U1"], current: { U1: { difficulty: "low", tags: [" a ", "", "b"] } } } });
		const { done, press, field } = mount(r);
		press(KEY.tab, "e");
		expect(field.sets).toEqual(["a, b"]);
		press(KEY.enter, KEY.tab, KEY.tab, "1", KEY.enter, KEY.enter);
		expect(done).toHaveBeenCalledWith({ kind: "result", result: { outcome: "approved", notes: "" } });
	});

	test("focus propagates to the open field", () => {
		const { press, field, component } = mount(request());
		component.focused = true;
		expect(field.focused).toBe(false);
		press("n");
		expect(field.focused).toBe(true);
		press(KEY.escape);
		expect(field.focused).toBe(false);
	});

	test("render uses the terminal rows for height (rows - 4, at least 10)", () => {
		const summary = Array.from({ length: 60 }, (_, i) => `fact ${i}`).join("\n");
		expect(mount(request({ summary }), 30).component.render(80).length).toBe(26);
		expect(mount(request({ summary }), 5).component.render(80).length).toBe(10);
	});

	test("default field wraps the pi-tui Editor: typing and submit", () => {
		const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 80 } } as unknown as TUI;
		const done = vi.fn<(o: DialogOutcome) => void>();
		const component = createDialog(request())(tui, theme, kb, done) as Component & Focusable;
		component.focused = true;
		for (const k of ["n", "o", "k"]) component.handleInput?.(k);
		const lines = component.render(60);
		expect(lines.some((l) => l.includes("ok"))).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		for (const k of [KEY.enter, KEY.enter, KEY.enter]) component.handleInput?.(k);
		expect(done).toHaveBeenCalledWith({ kind: "result", result: { outcome: "approved_with_notes", notes: "ok" } });
	});
});
