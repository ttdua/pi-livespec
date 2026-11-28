import { describe, expect, test } from "vitest";
import type { ApprovalRequest, Briefing, RequestOption } from "../../../src/interaction/approver.ts";
import { CANCELLED } from "../../../src/interaction/flow-result.ts";
import { buildModel, toResult } from "../../../src/interaction/dialog/model.ts";
import { initialState, reduce, type DialogState } from "../../../src/interaction/dialog/state.ts";

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

const question = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
	request({
		kind: "question",
		subject: "question:Q2",
		summary: "Q2: Which limit?",
		question: { id: "Q2", class: "blocking" },
		...over,
	});

const OPTIONS: RequestOption[] = [
	{ id: "A", label: "Option A", description: "first" },
	{ id: "B", label: "Option B", description: "second" },
];

const stuck = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
	request({ kind: "stuck", subject: "stuck:S1", summary: "Stuck", options: OPTIONS, ...over });

const failing = (): ApprovalRequest =>
	request({
		options: [{ id: "waive", label: "Waive size-limits" }],
		record: { ...request().record, snapshot: { target: "plan", failingWaivable: ["size-limits"] } },
	});

/** A state with entry `id`'s action picked. */
function picked(model: ReturnType<typeof buildModel>, kind: string, over: Partial<DialogState> = {}): DialogState {
	const index = model.entries.findIndex((e) => e.action.kind === kind || (e.action.kind === "option" && e.action.id === kind));
	if (index < 0) throw new Error(`no entry ${kind}`);
	return { ...initialState(model), picked: index, ...over };
}

describe("buildModel", () => {
	test("define gate: tabs and entries in gateChoices order with descriptions", () => {
		const m = buildModel(request());
		expect(m.kind).toBe("gate");
		expect(m.tabs).toEqual(["decision", "review"]);
		expect(m.entries.map((e) => e.action.kind)).toEqual(["approve", "changes", "dismiss"]);
		expect(m.entries[0]).toMatchObject({ label: "approve", description: "Accept the spec; the change moves to plan.", recommended: false });
		expect(m.notes).toBe(true);
	});

	test("recommended entry first and marked", () => {
		const briefing: Briefing = { summary: "S", recommended: "changes", rationale: "r", author: "agent" };
		const m = buildModel(request({ briefing }));
		expect(m.entries.map((e) => e.action.kind)).toEqual(["changes", "approve", "dismiss"]);
		expect(m.entries[0]?.recommended).toBe(true);
		expect(m.briefing?.heading).toBe("Agent recommendation (agent-authored, advisory)");
		expect(m.briefing?.lines).toContain("Recommended: request changes");
	});

	test("rule briefing heading", () => {
		const m = buildModel(request({ briefing: { summary: "S", author: "rule" } }));
		expect(m.briefing?.heading).toBe("Livespec rule recommendation");
	});

	test("plan gate with overridable offers units but hides the tab by default", () => {
		const m = buildModel(request({ overridable: { units: ["U1", "U2"], current: { U1: { difficulty: "high", tags: ["security"] } } } }));
		expect(m.tabs).toEqual(["decision", "review"]);
		expect(m.unitsAvailable).toBe(true);
		expect(m.units).toEqual([{ unit: "U1", label: "U1", difficulty: "high", tags: ["security"] }, { unit: "U2", label: "U2", tags: [] }]);
	});

	test("failing waivable check: no approve, one waive entry, a status row", () => {
		const m = buildModel(failing());
		expect(m.entries.map((e) => e.action)).toEqual([{ kind: "changes" }, { kind: "dismiss" }, { kind: "option", id: "waive" }]);
		expect(m.entries.some((e) => e.action.kind === "approve")).toBe(false);
		expect(m.entries.filter((e) => e.action.kind === "option")).toHaveLength(1);
		expect(m.status).toEqual([{ symbol: "!", text: expect.stringContaining("size-limits") }]);
	});

	test("question with candidates: candidates, own, later", () => {
		const m = buildModel(question({ options: OPTIONS }));
		expect(m.kind).toBe("question");
		expect(m.entries.map((e) => e.action.kind)).toEqual(["candidate", "candidate", "own", "later"]);
		expect(m.entries[2]?.label).toBe("write my own answer");
		expect(m).not.toHaveProperty("requirements");
		expect(m.notes).toBe(false);
	});

	test("Question without candidates: only own and later", () => {
		const m = buildModel(question());
		expect(m.entries.map((e) => e.action.kind)).toEqual(["own", "later"]);
	});

	test("stuck with B recommended: B first and marked", () => {
		const m = buildModel(stuck({ briefing: { summary: "S", recommended: "B", rationale: "r", author: "agent" } }));
		expect(m.kind).toBe("choice");
		expect(m.entries.map((e) => e.action)).toEqual([{ kind: "option", id: "B" }, { kind: "option", id: "A" }]);
		expect(m.entries[0]?.recommended).toBe(true);
		expect(m.notes).toBe(false);
	});

	test("decide: ask is a choice", () => {
		const m = buildModel(request({ subject: "decide:difficulty.U1", options: OPTIONS }));
		expect(m.kind).toBe("choice");
		expect(m.notes).toBe(false);
	});

	test("strips control characters", () => {
		const evil = "x\x1b[2Jy\x1b]0;title\x07z\rw\u202eq\u2066\u009b\u007f\tt";
		const m = buildModel(
			request({
				summary: evil,
				briefing: { summary: evil, watch: [evil], author: "agent" },
				options: [{ id: "o", label: evil, description: evil }],
			}),
		);
		const all = [m.facts, ...(m.briefing?.lines ?? []), ...m.entries.flatMap((e) => [e.label, e.description ?? ""])];
		for (const text of all) {
			expect(text).not.toMatch(/[\u001b\r\u202e\u0007\u2066\u009b\u007f]/);
			expect(text).not.toContain("[2J");
			expect(text).not.toContain("title");
		}
		expect(m.facts).toBe("xyzwq  t");
		const opt = m.entries.find((e) => e.action.kind === "option");
		expect(opt?.label).toBe("xyzwq  t");
		expect(opt?.description).toBe("xyzwq  t");
		expect(m.briefing?.lines.join("\n")).toContain("xyzwq  t");
		expect(buildModel(request({ summary: "a\nb" })).facts).toBe("a\nb");
	});
});

describe("toResult", () => {
	test("a unit id stays raw in Override.unit", () => {
		const raw = "U\t1";
		const r = request({ overridable: { units: [raw], current: {} } });
		const m = buildModel(r);
		expect(m.units[0]?.label).not.toContain("\t");
		expect(toResult(m, picked(m, "approve", { overrides: { [raw]: { difficulty: "high" } } }))).toMatchObject({ overrides: [{ unit: raw, difficulty: "high" }] });
	});

	test("stuck choice ignores notes and overrides", () => {
		const r = stuck({ overridable: { units: ["U1"], current: {} } });
		const m = buildModel(r);
		expect(toResult(m, picked(m, "B", { notes: "x", overrides: { U1: { difficulty: "high" } } }))).toEqual({ outcome: "approved", notes: "", choice: "B" });
	});

	test("approve with empty notes", () => {
		const r = request();
		const m = buildModel(r);
		expect(toResult(m, picked(m, "approve"))).toEqual({ outcome: "approved", notes: "" });
	});

	test("approve with notes", () => {
		const r = request();
		const m = buildModel(r);
		expect(toResult(m, picked(m, "approve", { notes: " ok " }))).toEqual({ outcome: "approved_with_notes", notes: "ok" });
	});

	test("option waive", () => {
		const r = failing();
		const m = buildModel(r);
		expect(toResult(m, picked(m, "waive"))).toEqual({ outcome: "approved", notes: "", choice: "waive" });
	});

	test("changes with notes", () => {
		const r = request();
		const m = buildModel(r);
		expect(toResult(m, picked(m, "changes", { notes: "fix it" }))).toEqual({ outcome: "changes_requested", notes: "fix it" });
	});

	test("overrides only differ from current, in model.units order", () => {
		const r = request({ overridable: { units: ["U1", "U2", "U3"], current: { U1: { difficulty: "low", tags: ["a"] }, U2: { difficulty: "high", tags: [] } } } });
		const m = buildModel(r);
		const state = picked(m, "approve", {
			overrides: { U3: { tags: ["x"] }, U2: { difficulty: "high" }, U1: { difficulty: "medium", tags: ["a"] } },
		});
		expect(toResult(m, state)).toEqual({
			outcome: "approved",
			notes: "",
			overrides: [{ unit: "U1", difficulty: "medium" }, { unit: "U3", tags: ["x"] }],
		});
	});

	test("Value set back to the current one: no override", () => {
		const r = request({ overridable: { units: ["U1"], current: { U1: { difficulty: "low", tags: [] } } } });
		const m = buildModel(r);
		const result = toResult(m, picked(m, "approve", { overrides: { U1: { difficulty: "low", tags: [] } } }));
		expect(result).toEqual({ outcome: "approved", notes: "" });
	});

	test("current tags are trimmed, empty ones dropped and commas removed", () => {
		const r = request({ overridable: { units: ["U1"], current: { U1: { tags: [" a ", "", "b", "c,d"] } } } });
		expect(buildModel(r).units[0]?.tags).toEqual(["a", "b", "cd"]);
	});

	test("unchanged tags prefill yields no override", () => {
		const r = request({ overridable: { units: ["U1"], current: { U1: { difficulty: "low", tags: ["\tsec", "\x07 api", "\x1b[2J"] } } } });
		const m = buildModel(r);
		const prefill = m.units[0]?.tags.join(", ") ?? "";
		const onUnits = { ...initialState(m), tab: 1 };
		const edited = reduce(m, reduce(m, onUnits, { type: "openEditor", editor: "tags" }), { type: "closeEditor", text: prefill });
		expect(toResult(m, { ...edited, picked: 0 })).toEqual({ outcome: "approved", notes: "" });
	});

	test("Overrides discarded with request changes", () => {
		const r = request({ overridable: { units: ["U1"], current: { U1: { difficulty: "low", tags: [] } } } });
		const m = buildModel(r);
		const result = toResult(m, picked(m, "changes", { notes: "n", overrides: { U1: { difficulty: "high" } } }));
		expect(result).toEqual({ outcome: "changes_requested", notes: "n" });
	});

	test("Question answered in the dialog", () => {
		const r = question({ options: OPTIONS });
		const m = buildModel(r);
		expect(toResult(m, { ...initialState(m), picked: 0 })).toEqual({ outcome: "approved", notes: "", answer: "Option A" });
		const none = toResult(m, { ...initialState(m), picked: 1 });
		expect(none).toEqual({ outcome: "approved", notes: "", answer: "Option B" });
	});

	test("Own answer typed in the dialog", () => {
		const r = question({ options: OPTIONS });
		const m = buildModel(r);
		const state = picked(m, "own", { answer: "  mine  " });
		expect(toResult(m, state)).toEqual({ outcome: "approved", notes: "", answer: "mine" });
	});

	test("later is deferred", () => {
		const r = question();
		const m = buildModel(r);
		expect(toResult(m, picked(m, "later"))).toEqual({ status: "deferred", questionClass: "non-blocking" });
	});

	test("dismiss and nothing picked are cancelled", () => {
		const r = request();
		const m = buildModel(r);
		expect(toResult(m, picked(m, "dismiss"))).toBe(CANCELLED);
		expect(toResult(m, initialState(m))).toBe(CANCELLED);
	});

	test("stuck B", () => {
		const r = stuck();
		const m = buildModel(r);
		expect(toResult(m, picked(m, "B"))).toEqual({ outcome: "approved", notes: "", choice: "B" });
	});
});
