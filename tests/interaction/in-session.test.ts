import { describe, expect, test } from "vitest";
import type { ApprovalRequest, Approver, ApproverUI, Pending } from "../../src/interaction/approver.ts";
import { runChain } from "../../src/interaction/chain.ts";
import { KEY, scriptedDialog, typed } from "../helpers/dialog.ts";
import { pickByLabel } from "../helpers/menu.ts";
import { createInSessionApprover } from "../../src/interaction/in-session.ts";

type Call =
	| { method: "select"; title: string; options: string[] }
	| { method: "input"; title: string; placeholder?: string };

/** A fake `ApproverUI` that answers from a script, in order, and records every call. */
function scriptedUI(answers: (string | undefined)[], hasUI = true): ApproverUI & { calls: Call[] } {
	const calls: Call[] = [];
	const next = (): string | undefined => {
		if (answers.length === 0) throw new Error(`unscripted UI call: ${JSON.stringify(calls.at(-1))}`);
		return answers.shift();
	};
	return {
		hasUI,
		calls,
		select: async (title, options) => {
			calls.push({ method: "select", title, options });
			const answer = next();
			return answer === undefined ? undefined : (options.includes(answer) ? answer : (pickByLabel(options, answer) ?? answer));
		},
		input: async (title, placeholder) => {
			calls.push({ method: "input", title, placeholder });
			return next();
		},
	};
}

const login = async () => "alice";

function gateRequest(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
	const base: ApprovalRequest = {
		id: "gate-define.abc",
		kind: "gate",
		subject: "gate:define",
		record: {
			id: "gate-define.abc",
			kind: "gate",
			subject: "gate:define",
			mode: "blocking",
			head_sha: "deadbeef",
			snapshot: { target: "define", failingWaivable: [] },
			summary: "Approve define?",
		},
		change: 7,
		phase: "define",
		summary: "Approve define?",
		links: [],
		files: [],
		mode: "blocking",
	};
	return { ...base, ...over };
}

function questionRequest(): ApprovalRequest {
	return gateRequest({
		id: "question-Q2.abc",
		kind: "question",
		subject: "question:Q2",
		summary: "Q2: Which limit applies?",
		question: { id: "Q2", class: "blocking" },
	});
}

describe("in-session approver", () => {
	test("Approve in the TUI", async () => {
		const ui = scriptedUI(["approve", "No notes"]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ status: "answered", outcome: "approved", notes: "", by: "alice", adapter: "in-session" });
		expect(result.status === "answered" && Number.isNaN(Date.parse(result.at))).toBe(false);
		expect(ui.calls[0]).toEqual({
			method: "select",
			title: "Approve define?",
			options: [
				"approve — Accept the spec; the change moves to plan.",
				"request changes — Send the request back with notes; nothing is approved.",
				"dismiss — Close the request without approving it.",
			],
		});
	});

	test("approve with notes is approved_with_notes", async () => {
		const ui = scriptedUI(["approve", "Add notes", "looks good"]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ outcome: "approved_with_notes", notes: "looks good" });
	});

	test("cancelled select is dismissed", async () => {
		const ui = scriptedUI([undefined]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ status: "answered", outcome: "dismissed", adapter: "in-session" });
	});

	test("cancelled notes input after approve is dismissed", async () => {
		const ui = scriptedUI(["approve", "Add notes", undefined]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ outcome: "dismissed" });
	});

	test("dismiss is dismissed", async () => {
		const ui = scriptedUI(["dismiss"]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ outcome: "dismissed" });
	});

	test("changes asks for notes", async () => {
		const ui = scriptedUI(["request changes", "split U3"]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ outcome: "changes_requested", notes: "split U3" });
		expect(ui.calls[1].method).toBe("input");
	});

	test("changes with cancelled notes is dismissed", async () => {
		const ui = scriptedUI(["request changes", undefined]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ outcome: "dismissed" });
	});

	test("waive option is offered when given", async () => {
		const ui = scriptedUI(["Waive failing checks", "No notes"]);
		const request = gateRequest({ options: [{ id: "waive", label: "Waive failing checks" }] });
		const result = await createInSessionApprover(ui, login).request(request);
		expect(ui.calls[0]).toMatchObject({
			options: [
				"approve — Accept the spec; the change moves to plan.",
				"request changes — Send the request back with notes; nothing is approved.",
				"dismiss — Close the request without approving it.",
				expect.stringMatching(/^Waive failing checks — /),
			],
		});
		expect(result).toMatchObject({ outcome: "approved", choice: "waive" });
	});

	test("failing waivable checks remove plain approve", async () => {
		const ui = scriptedUI(["Waive failing checks", "No notes"]);
		const base = gateRequest({ options: [{ id: "waive", label: "Waive failing checks" }] });
		const request = { ...base, record: { ...base.record, snapshot: { target: "define", failingWaivable: ["size-limits"] } } };
		const result = await createInSessionApprover(ui, login).request(request);
		expect(ui.calls[0]).toMatchObject({ options: ["request changes — Send the request back with notes; nothing is approved.", "dismiss — Close the request without approving it.", "Waive failing checks — Approve and waive the failing checks: size-limits."] });
		expect(result).toMatchObject({ outcome: "approved", choice: "waive" });
	});

	test("picking a candidate is one select call and no requirement step", async () => {
		const request = { ...questionRequest(), options: [{ id: "A", label: "per-user limits" }, { id: "B", label: "per-IP limits" }] };
		const ui = scriptedUI(["per-user limits"]);
		const result = await createInSessionApprover(ui, login).request(request);
		expect(ui.calls.filter((c) => c.method === "select")).toHaveLength(1);
		expect(ui.calls.filter((c) => c.method === "input")).toHaveLength(0);
		expect(result).toMatchObject({ status: "answered", outcome: "approved", answer: "per-user limits", adapter: "in-session" });
		expect(result).not.toHaveProperty("changesRequirement");
	});

	test("in-session question answer has no questionClass", async () => {
		const request = { ...questionRequest(), options: [{ id: "A", label: "per-user limits" }, { id: "B", label: "per-IP limits" }] };
		const result = await createInSessionApprover(scriptedUI(["per-user limits"]), login).request(request);
		expect(result).not.toHaveProperty("questionClass");
	});

	test("an own answer is one input call after the entry select", async () => {
		const ui = scriptedUI(["answer now", "no limit"]);
		const result = await createInSessionApprover(ui, login).request(questionRequest());
		expect(ui.calls.filter((c) => c.method === "input")).toHaveLength(1);
		expect(ui.calls).toHaveLength(2);
		expect(result).toMatchObject({ outcome: "approved", answer: "no limit" });
		expect(result).not.toHaveProperty("changesRequirement");
	});

	test("cancelled question answer is dismissed", async () => {
		const ui = scriptedUI(["answer now", undefined]);
		const result = await createInSessionApprover(ui, login).request(questionRequest());
		expect(result).toMatchObject({ outcome: "dismissed" });
	});

	test("answer later defers as non-blocking", async () => {
		const ui = scriptedUI(["answer later (non-blocking)"]);
		const result = await createInSessionApprover(ui, login).request(questionRequest());
		expect(result).toEqual({ status: "deferred", questionClass: "non-blocking" });
	});

	test("stuck options are chosen by label", async () => {
		const ui = scriptedUI(["Try B"]);
		const request = gateRequest({
			kind: "stuck",
			subject: "stuck:S1",
			options: [
				{ id: "a", label: "Try A" },
				{ id: "b", label: "Try B" },
			],
		});
		const result = await createInSessionApprover(ui, login).request(request);
		expect(ui.calls[0]).toMatchObject({ options: ["Try A", "Try B"] });
		expect(result).toMatchObject({ outcome: "approved", choice: "b" });
	});

	test("override prompts set difficulty and tags", async () => {
		const ui = scriptedUI([
			"approve",
			"No notes",
			"Adjust Difficulty or Tags",
			"U2",
			"difficulty",
			"high",
			"U2",
			"tags",
			"api, db",
			"done",
		]);
		const request = gateRequest({ subject: "gate:plan", phase: "plan", overridable: { units: ["U1", "U2"] } });
		const result = await createInSessionApprover(ui, login).request(request);
		expect(ui.calls[1]).toMatchObject({ method: "select", options: ["No notes", "Add notes"] });
		expect(ui.calls[2]).toMatchObject({
			method: "select",
			title: "Adjust Difficulty or Tags?",
			options: ["Keep classification", "Adjust Difficulty or Tags"],
		});
		expect(ui.calls[3]).toMatchObject({ method: "select", options: ["U1", "U2", "done"] });
		expect(result).toMatchObject({
			outcome: "approved",
			overrides: [{ unit: "U2", difficulty: "high", tags: ["api", "db"] }],
		});
	});

	test("no override prompt after changes", async () => {
		const ui = scriptedUI(["request changes", "redo"]);
		const request = gateRequest({ subject: "gate:plan", overridable: { units: ["U1"] } });
		const result = await createInSessionApprover(ui, login).request(request);
		expect(result).toMatchObject({ outcome: "changes_requested" });
		expect(result).not.toHaveProperty("overrides");
	});

	test("cancelled override prompt is dismissed", async () => {
		const ui = scriptedUI(["approve", "No notes", "Adjust Difficulty or Tags", undefined]);
		const request = gateRequest({ subject: "gate:plan", overridable: { units: ["U1"] } });
		const result = await createInSessionApprover(ui, login).request(request);
		expect(result).toMatchObject({ outcome: "dismissed" });
	});

	test("cancel at the notes prompt is dismissed", async () => {
		const ui = scriptedUI(["approve", undefined]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ outcome: "dismissed", notes: "" });
	});

	test("cancel at the override prompt is dismissed", async () => {
		const ui = scriptedUI(["approve", "No notes", undefined]);
		const request = gateRequest({ subject: "gate:plan", overridable: { units: ["U1"] } });
		const result = await createInSessionApprover(ui, login).request(request);
		expect(result).toMatchObject({ outcome: "dismissed" });
		expect(result).not.toHaveProperty("overrides");
	});

	test("explicit no at the notes and override prompts approves without notes or overrides", async () => {
		const ui = scriptedUI(["approve", "No notes", "Keep classification"]);
		const request = gateRequest({ subject: "gate:plan", overridable: { units: ["U1"] } });
		const result = await createInSessionApprover(ui, login).request(request);
		expect(result).toMatchObject({ outcome: "approved", notes: "" });
		expect(result).not.toHaveProperty("overrides");
	});

	test("option label colliding with a built-in action maps to the option, not the action", async () => {
		const request = gateRequest({ options: [{ id: "waive", label: "approve" }] });
		const pickOption = scriptedUI(["approve — Approve and waive the failing checks: .", "No notes"]);
		const viaOption = await createInSessionApprover(pickOption, login).request(request);
		expect(pickOption.calls[0]).toMatchObject({ options: [expect.stringMatching(/^approve — Accept/), expect.anything(), expect.anything(), "approve — Approve and waive the failing checks: ."] });
		expect(viaOption).toMatchObject({ outcome: "approved", choice: "waive" });

		const pickBuiltin = scriptedUI(["approve", "No notes"]);
		const viaBuiltin = await createInSessionApprover(pickBuiltin, login).request(request);
		expect(viaBuiltin).toMatchObject({ outcome: "approved" });
		expect(viaBuiltin).not.toHaveProperty("choice");
	});

	test("two options sharing a label map to their own ids", async () => {
		const request = gateRequest({
			kind: "stuck",
			subject: "stuck:S1",
			options: [
				{ id: "a", label: "Retry" },
				{ id: "b", label: "Retry" },
			],
		});
		const ui = scriptedUI(["Retry (2)"]);
		const result = await createInSessionApprover(ui, login).request(request);
		expect(ui.calls[0]).toMatchObject({ options: ["Retry", "Retry (2)"] });
		expect(result).toMatchObject({ outcome: "approved", choice: "b" });
	});

	test("options whose rendered labels collide stay distinct and each maps to its own id", async () => {
		const request = gateRequest({
			kind: "stuck",
			subject: "stuck:S1",
			options: [
				{ id: "a] [b", label: "Retry" },
				{ id: "b", label: "Retry [a]" },
			],
		});
		const first = scriptedUI(["Retry"]);
		const viaFirst = await createInSessionApprover(first, login).request(request);
		const menu = (first.calls[0] as { options: string[] }).options;
		expect(menu).toEqual(["Retry", "Retry [a]"]);
		expect(viaFirst).toMatchObject({ outcome: "approved", choice: "a] [b" });

		const second = scriptedUI(["Retry [a]"]);
		const viaSecond = await createInSessionApprover(second, login).request(request);
		expect(viaSecond).toMatchObject({ outcome: "approved", choice: "b" });
	});

	test("duplicate option ids are offered once", async () => {
		const request = gateRequest({
			options: [
				{ id: "x", label: "Go" },
				{ id: "x", label: "Go" },
			],
		});
		const ui = scriptedUI(["Go", "No notes"]);
		const result = await createInSessionApprover(ui, login).request(request);
		expect(ui.calls[0]).toMatchObject({
			options: [expect.anything(), expect.anything(), expect.anything(), "Go"],
		});
		expect(result).toMatchObject({ outcome: "approved", choice: "x" });
	});

	test("a label that is not in the menu is dismissed", async () => {
		const request = gateRequest({ kind: "stuck", subject: "stuck:S1", options: [{ id: "a", label: "Retry" }] });
		const result = await createInSessionApprover(scriptedUI(["Retry [a]"]), login).request(request);
		expect(result).toMatchObject({ outcome: "dismissed" });
	});

	test("Unavailable without UI", async () => {
		const ui = scriptedUI([], false);
		const inSession = createInSessionApprover(ui, login);
		expect(inSession.available()).toBe(false);
		const received: ApprovalRequest[] = [];
		const forge: Approver = {
			name: "forge",
			available: () => true,
			request: async (r): Promise<Pending> => {
				received.push(r);
				return { status: "pending", requestId: r.id };
			},
		};
		const result = await runChain(["in-session", "forge"], { "in-session": inSession, forge }, gateRequest(), {
			onDeferred: async () => {},
		});
		expect(result).toEqual({ status: "pending", requestId: "gate-define.abc" });
		expect(received).toHaveLength(1);
		expect(ui.calls).toEqual([]);
	});

	test("available with UI", () => {
		expect(createInSessionApprover(scriptedUI([]), login).available()).toBe(true);
	});

	describe("briefing and descriptions", () => {
		const stuck = (briefing?: ApprovalRequest["briefing"]): ApprovalRequest =>
			gateRequest({
				kind: "stuck",
				subject: "stuck:S1",
				options: [
					{ id: "A", label: "A-label", description: "A-desc" },
					{ id: "B", label: "B-label", description: "B-desc" },
				],
				...(briefing ? { briefing } : {}),
			});
		const advice = { summary: "B is cheaper.", rationale: "Fewer moving parts.", recommended: "B", author: "agent" as const };

		test("Recommended entry first", async () => {
			const ui = scriptedUI(["B-label — B-desc (Recommended)"]);
			const result = await createInSessionApprover(ui, login).request(stuck(advice));
			expect(ui.calls[0]).toMatchObject({ options: ["B-label — B-desc (Recommended)", "A-label — A-desc"] });
			expect(result).toMatchObject({ outcome: "approved", choice: "B" });
		});

		test("Briefing shown before options", async () => {
			const ui = scriptedUI(["B-label — B-desc (Recommended)"]);
			await createInSessionApprover(ui, login).request(stuck(advice));
			const title = (ui.calls[0] as { title: string }).title;
			expect(title.startsWith("Approve define?\n\n")).toBe(true);
			expect(title.indexOf("B is cheaper.")).toBeGreaterThan(title.indexOf("Approve define?"));
			expect(title).toContain("Fewer moving parts.");
			expect(title).toContain("agent-authored");
			expect(title).toContain("Recommended: B-label");
		});

		test("no entry shows a raw id suffix", async () => {
			const ui = scriptedUI(["A-label — A-desc"]);
			await createInSessionApprover(ui, login).request(stuck());
			for (const o of (ui.calls[0] as { options: string[] }).options) expect(o).not.toMatch(/\[[^\]]+\]$/);
		});

		test("duplicate labels with descriptions stay distinct", async () => {
			const request = gateRequest({
				kind: "stuck",
				subject: "stuck:S1",
				options: [
					{ id: "a", label: "Retry", description: "same" },
					{ id: "b", label: "Retry", description: "same" },
				],
			});
			const ui = scriptedUI(["Retry — same (2)"]);
			const result = await createInSessionApprover(ui, login).request(request);
			expect(ui.calls[0]).toMatchObject({ options: ["Retry — same", "Retry — same (2)"] });
			expect(result).toMatchObject({ choice: "b" });
		});

		test("Recommendation is not an answer", async () => {
			const result = await createInSessionApprover(scriptedUI([undefined]), login).request(stuck(advice));
			expect(result).toMatchObject({ outcome: "dismissed" });
			expect(result).not.toHaveProperty("choice");
		});

		test("a rule briefing is not labelled as agent-authored", async () => {
			const ui = scriptedUI([undefined]);
			await createInSessionApprover(ui, login).request(stuck({ summary: "Rule says so.", author: "rule" }));
			const title = (ui.calls[0] as { title: string }).title;
			expect(title).toContain("Livespec rule recommendation");
			expect(title).not.toContain("agent-authored");
		});

		const withCandidates = (): ApprovalRequest => ({
			...questionRequest(),
			options: [
				{ id: "A", label: "per-IP limits", description: "keep" },
				{ id: "B", label: "per-user limits", description: "change" },
			],
		});

		test("Question candidate picked in session", async () => {
			const ui = scriptedUI(["per-user limits — change", "no"]);
			const result = await createInSessionApprover(ui, login).request(withCandidates());
			expect(ui.calls[0]).toMatchObject({
				options: ["per-IP limits — keep", "per-user limits — change", "write my own answer", "answer later (non-blocking)"],
			});
			expect(result).toMatchObject({ outcome: "approved", answer: "per-user limits" });
		});

		test("Own answer instead of a candidate", async () => {
			const ui = scriptedUI(["write my own answer", "something else", "no"]);
			const result = await createInSessionApprover(ui, login).request(withCandidates());
			expect(result).toMatchObject({ outcome: "approved", answer: "something else" });
		});
	});
});

describe("in-session dialog path", () => {
	/** `ui` with a scripted dialog; `select`/`input` throw if called without a script. */
	const withDialog = (keys: string[], answers: (string | undefined)[] = []) => {
		const dialog = scriptedDialog(keys);
		const ui = Object.assign(scriptedUI(answers), { dialog });
		return { ui, dialog };
	};
	const withoutAt = (a: Awaited<ReturnType<Approver["request"]>>) => {
		if (a.status !== "answered") return a;
		const { at: _at, ...rest } = a;
		return rest;
	};
	const stuckRequest = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
		gateRequest({
			kind: "stuck",
			subject: "stuck:S1",
			options: [
				{ id: "A", label: "A-label", description: "A-desc" },
				{ id: "B", label: "B-label", description: "B-desc" },
			],
			briefing: { summary: "B is cheaper.", recommended: "B", author: "agent" },
			...over,
		});

	test("Dialog in the TUI", async () => {
		const { ui, dialog } = withDialog([KEY.enter, KEY.enter]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(dialog.opened).toBe(1);
		expect(ui.calls).toEqual([]);
		expect(result).toMatchObject({ status: "answered", outcome: "approved", notes: "", by: "alice", adapter: "in-session" });
	});

	test("Fallback when the dialog draws nothing", async () => {
		const { ui, dialog } = withDialog([], ["A-label — A-desc"]);
		const result = await createInSessionApprover(ui, login).request(stuckRequest());
		expect(dialog.opened).toBe(1);
		expect(ui.calls).toHaveLength(1);
		expect(ui.calls[0]?.method).toBe("select");
		expect(result).toMatchObject({ status: "answered", outcome: "approved", choice: "A", adapter: "in-session" });
	});

	test("explicit cancel is not a fallback", async () => {
		const { ui } = withDialog([KEY.escape]);
		const result = await createInSessionApprover(ui, login).request(stuckRequest());
		expect(ui.calls).toEqual([]);
		expect(result).toMatchObject({ status: "answered", outcome: "dismissed", notes: "", adapter: "in-session" });
		expect(result).not.toHaveProperty("choice");
	});

	test("answer later in the dialog is deferred", async () => {
		const { ui } = withDialog(["2"]);
		const result = await createInSessionApprover(ui, login).request(questionRequest());
		expect(result).toEqual({ status: "deferred", questionClass: "non-blocking" });
	});

	test("Empty required text in the fallback", async () => {
		const ui = scriptedUI(["request changes", ""]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ status: "answered", outcome: "dismissed", notes: "" });
	});

	describe("dialog and select chain agree", () => {
		const candidates = (): ApprovalRequest => ({
			...questionRequest(),
			options: [
				{ id: "A", label: "per-IP limits", description: "keep" },
				{ id: "B", label: "per-user limits", description: "change" },
			],
		});
		const plan = (): ApprovalRequest =>
			gateRequest({
				subject: "gate:plan",
				phase: "plan",
				overridable: { units: ["U1", "U2"], current: { U1: { difficulty: "low", tags: [] }, U2: { difficulty: "medium", tags: ["db"] } } },
			});
		const decide = (): ApprovalRequest =>
			gateRequest({
				kind: "stuck",
				subject: "decide:behavior-change.U1",
				options: [
					{ id: "unchanged", label: "Behavior did not change" },
					{ id: "changed", label: "Behavior changed; the spec must be updated" },
				],
			});
		const cases: { name: string; request: () => ApprovalRequest; keys: string[]; select: string[] }[] = [
			{ name: "define gate with a note", request: () => gateRequest(), keys: ["n", ...typed("ok"), KEY.enter, "1", KEY.enter], select: ["approve", "Add notes", "ok"] },
			{ name: "define gate request changes", request: () => gateRequest(), keys: ["2", ...typed("split U3"), KEY.enter, KEY.tab, KEY.enter], select: ["request changes", "split U3"] },
			{
				name: "plan gate with overrides",
				request: plan,
				keys: ["1", KEY.right, KEY.right, KEY.tab, "n", ...typed("ok"), KEY.enter, KEY.enter],
				select: ["approve", "Add notes", "ok", "Adjust Difficulty or Tags", "U1", "difficulty", "high", "done"],
			},
			{
				name: "question with a candidate",
				request: candidates,
				keys: ["2", KEY.enter],
				select: ["per-user limits — change"],
			},
			{ name: "stuck report", request: () => stuckRequest(), keys: ["1", KEY.enter], select: ["B-label — B-desc (Recommended)"] },
			{ name: "decide ask", request: decide, keys: ["2", KEY.enter], select: ["Behavior changed; the spec must be updated"] },
		];

		test.each(cases)("$name", async ({ request, keys, select }) => {
			const viaDialog = withDialog(keys);
			const fromDialog = await createInSessionApprover(viaDialog.ui, login).request(request());
			const fromSelect = await createInSessionApprover(scriptedUI(select), login).request(request());
			expect(viaDialog.ui.calls).toEqual([]);
			expect(fromDialog.status).toBe("answered");
			expect(withoutAt(fromDialog)).toEqual(withoutAt(fromSelect));
		});

		test("Same answer on both paths: plan gate approve, note ok, U1 high", async () => {
			const viaDialog = withDialog(["1", KEY.right, KEY.right, KEY.tab, "n", ...typed("ok"), KEY.enter, KEY.enter]);
			const result = await createInSessionApprover(viaDialog.ui, login).request(plan());
			expect(result).toMatchObject({ outcome: "approved_with_notes", notes: "ok", overrides: [{ unit: "U1", difficulty: "high" }] });
		});
	});
});
