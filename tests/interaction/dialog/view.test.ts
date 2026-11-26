import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { ApprovalRequest, Briefing } from "../../../src/interaction/approver.ts";
import { buildModel, type DialogModel } from "../../../src/interaction/dialog/model.ts";
import { type DialogState, initialState } from "../../../src/interaction/dialog/state.ts";
import { toResult } from "../../../src/interaction/dialog/model.ts";
import { type DialogTheme, maxScrollOf, renderDialog } from "../../../src/interaction/dialog/view.ts";

const identity: DialogTheme = { accent: (s) => s, muted: (s) => s, bold: (s) => s };

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
	return {
		id: "gate-define.abc",
		kind: "gate",
		subject: "gate:define",
		record: { id: "gate-define.abc", kind: "gate", subject: "gate:define", mode: "blocking", head_sha: "d", snapshot: { target: "define", failingWaivable: [] }, summary: "Approve define?" },
		change: 7,
		phase: "define",
		summary: "Define payload: spec for rate limiting",
		links: [],
		files: [],
		mode: "blocking",
		...over,
	};
}

const BRIEFING: Briefing = { author: "agent", summary: "Looks complete", recommended: "approve", rationale: "All scenarios covered" };
const define = (): DialogModel => buildModel(request({ briefing: BRIEFING }));
const failing = (): DialogModel =>
	buildModel(request({ options: [{ id: "waive", label: "Waive spec-lint" }], record: { ...request().record, snapshot: { target: "plan", failingWaivable: ["spec-lint"] } } }));
const plan = (): DialogModel =>
	buildModel(request({ subject: "gate:plan", overridable: { units: ["U1", "U2"], current: { U1: { difficulty: "low", tags: ["security"] } } } }));

const at = (m: DialogModel, over: Partial<DialogState> = {}): DialogState => ({ ...initialState(m), ...over });
const draw = (m: DialogModel, s: DialogState = at(m), width = 80, height = 40, editor?: string[]) => renderDialog(m, s, { width, height }, identity, editor);
const pickOf = (m: DialogModel, kind: string): number => m.entries.findIndex((e) => e.action.kind === kind || (e.action.kind === "option" && e.action.id === kind));

describe("decision tab", () => {
	test("Briefing section in the dialog: 80-column define gate", () => {
		expect(draw(define())).toEqual([
			"[Decision]  Review",
			"",
			"Define payload: spec for rate limiting",
			"",
			"Agent recommendation (agent-authored, advisory)",
			"Looks complete",
			"Recommended: approve",
			"Why: All scenarios covered",
			"",
			"› 1 approve (Recommended)",
			"    Accept the spec; the change moves to plan.",
			"  2 request changes",
			"    Send the request back with notes; nothing is approved.",
			"  3 dismiss",
			"    Close the request without approving it.",
			"",
			"Note: — (n: add)",
			"↑↓ move · 1-9 pick · n note · Tab next tab · Enter select · Esc cancel",
		]);
	});

	test("active tab is bold as well as bracketed", () => {
		const theme: DialogTheme = { ...identity, bold: (s) => `*${s}*` };
		expect(renderDialog(define(), at(define()), { width: 80, height: 40 }, theme)[0]).toBe("*[Decision]*  Review");
	});

	test("Medium width hides descriptions and hints", () => {
		const lines = draw(define(), undefined, 50);
		expect(lines).toContain("› 1 approve (Recommended)");
		expect(lines.join("\n")).not.toContain("Accept the spec");
		expect(lines.join("\n")).not.toContain("Esc cancel");
	});

	test("width boundaries: 60 is full, 59 medium, 40 medium, 39 narrow", () => {
		expect(draw(define(), undefined, 60).join("\n")).toContain("Accept the spec");
		expect(draw(define(), undefined, 59).join("\n")).not.toContain("Accept the spec");
		expect(draw(define(), undefined, 40)).toContain("› 1 approve (Recommended)");
		expect(draw(define(), undefined, 39)).toHaveLength(1);
	});

	test("Narrow terminal: one line asking to widen or press Esc", () => {
		const lines = draw(define(), undefined, 35);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("widen");
		expect(lines[0]).toContain("Esc");
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(35);
	});

	test("Status without colour: the failing check line starts with !", () => {
		const lines = draw(failing());
		expect(lines.some((l) => l.startsWith("!") && l.includes("spec-lint"))).toBe(true);
	});

	test("Long briefing scrolls: entries stay, facts cut from the top by state.scroll", () => {
		const summary = Array.from({ length: 40 }, (_, i) => `fact ${i + 1}`).join("\n");
		const m = buildModel(request({ summary }));
		const lines = draw(m, at(m, { scroll: 5 }), 80, 20);
		expect(lines.length).toBeLessThanOrEqual(20);
		for (const label of ["› 1 approve", "  2 request changes", "  3 dismiss"]) expect(lines).toContain(label);
		expect(lines).toContain("fact 6");
		expect(lines).not.toContain("fact 5");
		expect(lines).not.toContain("fact 40");
		expect(lines.some((l) => l.includes("above"))).toBe(true);
		expect(lines.some((l) => l.includes("below"))).toBe(true);
	});

	test("a short terminal drops descriptions and hints before it drops entries", () => {
		const lines = draw(define(), undefined, 80, 10);
		expect(lines.length).toBeLessThanOrEqual(10);
		for (const label of ["› 1 approve (Recommended)", "  2 request changes", "  3 dismiss"]) expect(lines).toContain(label);
		expect(lines.join("\n")).not.toContain("Accept the spec");
	});

	test("scroll past the end is clamped to the last page", () => {
		const summary = Array.from({ length: 40 }, (_, i) => `fact ${i + 1}`).join("\n");
		const m = buildModel(request({ summary }));
		expect(draw(m, at(m, { scroll: 999 }), 80, 20)).toContain("fact 40");
	});

	test("a picked entry is marked and the error line starts with !", () => {
		const m = define();
		const lines = draw(m, at(m, { picked: 0, error: "Requested changes need a note" }));
		expect(lines).toContain("› 1 approve (Recommended) ✓");
		expect(lines).toContain("! Requested changes need a note");
	});

	test("an open editor's lines are drawn in place of the note line", () => {
		const m = define();
		const lines = draw(m, at(m, { editor: "note" }), 80, 40, ["┌──┐", "│ok│", "└──┘"]);
		expect(lines).not.toContain("Note: — (n: add)");
		expect(lines).toContain("Note:");
		expect(lines).toContain("│ok│");
		expect(lines).toContain("Enter save · Esc close editor");
	});

	test("a written note is shown on the note line", () => {
		const m = define();
		expect(draw(m, at(m, { notes: "tighten wording\nmore" }))).toContain("Note: tighten wording … (n: edit)");
	});

	test("choices have no note line", () => {
		const m = buildModel(request({ kind: "stuck", subject: "stuck:S1", options: [{ id: "A", label: "Option A" }] }));
		expect(draw(m).join("\n")).not.toContain("Note:");
	});
});

describe("text safety and width", () => {
	const EVIL = "x\x1b[2Jy\x1b]0;title\x07z\r\u202e漢字👍🏽\tend";
	const evil = (): DialogModel =>
		buildModel(
			request({
				summary: `${EVIL} ${"長い文字列".repeat(12)}`,
				briefing: { author: "agent", summary: EVIL, watch: [EVIL], rationale: "😀".repeat(50), recommended: "o" },
				options: [{ id: "o", label: `${EVIL} ${"ラベル".repeat(20)}`, description: "説明".repeat(40) }],
				overridable: { units: ["U漢字👍🏽"], current: { "U漢字👍🏽": { difficulty: "low", tags: ["タグ".repeat(30)] } } },
			}),
		);

	test("lines never exceed width with CJK, emoji and tabs", () => {
		const m = evil();
		for (const width of [40, 41, 50, 59, 60, 61, 80]) {
			for (const tab of [0, 1, 2]) {
				const picked = pickOf(m, "o");
				for (const line of draw(m, at(m, { tab, picked, notes: "メモ".repeat(50) }), width, 30)) {
					expect(visibleWidth(line), `width ${width} tab ${tab}: ${line}`).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	test("no escape sequences in output", () => {
		const m = evil();
		for (const width of [40, 50, 80]) {
			const out = [0, 1, 2].flatMap((tab) => draw(m, at(m, { tab, picked: pickOf(m, "o") }), width)).join("\n");
			expect(out).not.toMatch(/[\u001b\u0007\r\u202e]/);
			expect(out).not.toContain("title");
			expect(out).not.toContain("[2J");
		}
	});
});

describe("short terminals and scroll limits", () => {
	const long = (): DialogModel => buildModel(request({ summary: Array.from({ length: 40 }, (_, i) => `fact ${i + 1}`).join("\n") }));

	test("maxScrollOf is the last page's offset; 0 for a body that fits or a tab without one", () => {
		const m = long();
		const max = maxScrollOf(m, at(m), { width: 80, height: 20 });
		expect(max).toBeGreaterThan(0);
		expect(draw(m, at(m, { scroll: max }), 80, 20)).toContain("fact 40");
		expect(draw(m, at(m, { scroll: max + 1 }), 80, 20)).toEqual(draw(m, at(m, { scroll: max }), 80, 20));
		expect(maxScrollOf(define(), at(define()), { width: 80, height: 40 })).toBe(0);
		const p = plan();
		expect(maxScrollOf(p, at(p, { tab: 1 }), { width: 80, height: 10 })).toBe(0);
	});

	test("an open editor keeps every editor line on a 10-line terminal", () => {
		const m = define();
		const editor = Array.from({ length: 7 }, (_, i) => `editor ${i}`);
		const lines = draw(m, at(m, { editor: "note" }), 80, 10, editor);
		for (const line of editor) expect(lines).toContain(line);
		expect(lines.length).toBeLessThanOrEqual(10);
	});

	test("entries shrink to the focused row plus a count when an editor takes the room", () => {
		const m = define();
		const editor = Array.from({ length: 3 }, (_, i) => `editor ${i}`);
		const lines = draw(m, at(m, { editor: "note", focus: 1 }), 80, 10, editor);
		for (const line of editor) expect(lines).toContain(line);
		expect(lines.some((l) => /^… \d+ more$/.test(l))).toBe(true);
		expect(lines).toContain("› 2 request changes");
		expect(lines.length).toBeLessThanOrEqual(10);
	});

	test("one spare line says how much body is hidden", () => {
		const m = long();
		const found = [8, 9, 10, 11, 12, 13, 14].flatMap((height) => draw(m, at(m), 80, height)).filter((l) => /^↕ \d+ lines hidden \(PgUp\/PgDn\)$/.test(l));
		expect(found.length).toBeGreaterThan(0);
	});

	test("lines stay within width with a long editor at 20, 30 and 40 columns", () => {
		const m = define();
		const editor = ["x".repeat(100), "漢字".repeat(30)];
		for (const width of [20, 30, 40, 45]) for (const line of draw(m, at(m, { editor: "note" }), width, 12, editor)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	test("text typed in the dialog is sanitised in the output", () => {
		const m = define();
		const dirty = "bad\x07\x1b[2Jtext";
		const out = [draw(m, at(m, { notes: dirty })), draw(m, at(m, { tab: 1, picked: 0, notes: dirty }))].flat().join("\n");
		expect(out).not.toMatch(/[\u001b\u0007]/);
		expect(out).toContain("badtext");
		const q = buildModel(request({ kind: "question", subject: "question:Q2", question: { id: "Q2", class: "blocking", requirements: [] } }));
		const review = draw(q, at(q, { tab: 1, picked: 0, answer: dirty, requirement: { kind: "other", text: dirty } })).join("\n");
		expect(review).not.toMatch(/[\u001b\u0007]/);
	});
});

describe("outcome label agrees with toResult", () => {
	const shown = (m: DialogModel, over: Partial<DialogState>): string => draw(m, at(m, { tab: 1, ...over })).find((l) => l.startsWith("Outcome: ")) ?? "";
	const OUTCOME_TEXT: Record<string, string> = { approved: "approved", approved_with_notes: "approved with notes", changes_requested: "changes requested" };

	test.each([
		["approve, no notes", "approve", ""],
		["approve, whitespace notes", "approve", "  \n "],
		["approve with notes", "approve", "ok"],
		["changes", "changes", "split"],
	])("%s", (_name, kind, notes) => {
		const m = define();
		const state = at(m, { tab: 1, picked: pickOf(m, kind), notes });
		const result = toResult(m, state, request()) as { outcome: string };
		expect(shown(m, state)).toBe(`Outcome: ${OUTCOME_TEXT[result.outcome]}`);
	});

	test("an option on a waive gate", () => {
		const m = failing();
		const state = at(m, { tab: 1, picked: pickOf(m, "waive"), notes: "why" });
		const result = toResult(m, state, request()) as { outcome: string };
		expect(shown(m, state)).toBe(`Outcome: ${OUTCOME_TEXT[result.outcome]}`);
	});

	test("a choice approves even with stale notes", () => {
		const m = buildModel(request({ kind: "stuck", subject: "stuck:S1", options: [{ id: "A", label: "Option A" }] }));
		const state = at(m, { tab: 1, picked: 0, notes: "stale" });
		const result = toResult(m, state, request()) as { outcome: string };
		expect(shown(m, state)).toBe(`Outcome: ${OUTCOME_TEXT[result.outcome]}`);
	});
});

describe("units tab", () => {
	test("units show current difficulty and tags; a unit without values shows — and []", () => {
		const m = plan();
		const lines = draw(m, at(m, { tab: 1 }));
		expect(lines[0]).toBe("Decision  [Adjust units]  Review");
		expect(lines.some((l) => /^› U1 +low +\[security\]$/.test(l))).toBe(true);
		expect(lines.some((l) => /^ {2}U2 +— +\[\]$/.test(l))).toBe(true);
	});

	test("a changed value is shown with a changed mark", () => {
		const m = plan();
		const lines = draw(m, at(m, { tab: 1, overrides: { U1: { difficulty: "high" } } }));
		expect(lines.some((l) => /^› U1 +high +\[security\] +\(changed\)$/.test(l))).toBe(true);
	});

	test("the tags editor is drawn below the list", () => {
		const m = plan();
		const lines = draw(m, at(m, { tab: 1, editor: "tags" }), 80, 40, ["│security│"]);
		expect(lines).toContain("Tags of U1 (comma-separated):");
		expect(lines).toContain("│security│");
	});
});

describe("review tab", () => {
	test("Review shows the answer before it is sent: waive lists its label", () => {
		const m = failing();
		const lines = draw(m, at(m, { tab: 1, picked: pickOf(m, "waive") }));
		expect(lines[0]).toBe("Decision  [Review]");
		expect(lines).toContain("Outcome: approved");
		expect(lines).toContain("Choice: Waive spec-lint");
	});

	test("notes and overrides are listed", () => {
		const m = plan();
		const lines = draw(m, at(m, { tab: 2, picked: pickOf(m, "approve"), notes: "ok", overrides: { U1: { difficulty: "high" } } }));
		expect(lines).toContain("Outcome: approved with notes");
		expect(lines).toContain("Note: ok (n: edit)");
		expect(lines).toContain("Overrides:");
		expect(lines).toContain("  U1: difficulty high");
	});

	test("overrides are listed as discarded with request changes", () => {
		const m = plan();
		const lines = draw(m, at(m, { tab: 2, picked: pickOf(m, "changes"), notes: "split U1", overrides: { U1: { difficulty: "high", tags: ["a", "b"] } } }));
		expect(lines).toContain("Outcome: changes requested");
		expect(lines).toContain("Discarded with request changes:");
		expect(lines).toContain("  U1: difficulty high, tags [a, b]");
		expect(lines).not.toContain("Overrides:");
	});

	test("nothing picked says so", () => {
		const m = define();
		expect(draw(m, at(m, { tab: 1 })).join("\n")).toContain("Nothing picked yet");
	});

	test("a question shows the answer and the requirement rows", () => {
		const m = buildModel(
			request({
				kind: "question",
				subject: "question:Q2",
				options: [{ id: "p", label: "per-IP limits" }],
				question: { id: "Q2", class: "blocking", requirements: ["rate-limiting/Requirement: Limits"] },
			}),
		);
		const lines = draw(m, at(m, { tab: 1, picked: 0, focus: 1, requirement: { kind: "named", name: "rate-limiting/Requirement: Limits" } }));
		expect(lines).toContain("Answer: per-IP limits");
		expect(lines).toContain("Does the answer change a requirement?");
		expect(lines).toContain("  1 ( ) no");
		expect(lines).toContain("› 2 (•) rate-limiting/Requirement: Limits");
		expect(lines).toContain("  3 ( ) other");
	});

	test("a typed answer and a typed requirement are shown", () => {
		const m = buildModel(request({ kind: "question", subject: "question:Q2", question: { id: "Q2", class: "blocking", requirements: [] } }));
		const lines = draw(m, at(m, { tab: 1, picked: 0, answer: "no limit", requirement: { kind: "other", text: "a/b" } }));
		expect(lines).toContain("Answer: no limit");
		expect(lines).toContain("  2 (•) other: a/b");
	});
});
