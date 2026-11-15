import { describe, expect, test } from "vitest";
import type { ApprovalRequest, Approver, ApproverUI, Pending } from "../../src/interaction/approver.ts";
import { runChain } from "../../src/interaction/chain.ts";
import { createInSessionApprover } from "../../src/interaction/in-session.ts";

type Call =
	| { method: "select"; title: string; options: string[] }
	| { method: "confirm"; title: string; message: string }
	| { method: "input"; title: string; placeholder?: string };

/** A fake `ApproverUI` that answers from a script, in order, and records every call. */
function scriptedUI(answers: (string | boolean | undefined)[], hasUI = true): ApproverUI & { calls: Call[] } {
	const calls: Call[] = [];
	const next = (): string | boolean | undefined => {
		if (answers.length === 0) throw new Error(`unscripted UI call: ${JSON.stringify(calls.at(-1))}`);
		return answers.shift();
	};
	return {
		hasUI,
		calls,
		select: async (title, options) => {
			calls.push({ method: "select", title, options });
			return next() as string | undefined;
		},
		confirm: async (title, message) => {
			calls.push({ method: "confirm", title, message });
			return next() as boolean;
		},
		input: async (title, placeholder) => {
			calls.push({ method: "input", title, placeholder });
			return next() as string | undefined;
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
			snapshot: { target: "define", digests: {}, failingWaivable: [] },
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
		question: { id: "Q2", class: "blocking", requirements: ["rate-limit/Requirement: Per-IP cap", "auth/Requirement: Login"] },
	});
}

describe("in-session approver", () => {
	test("Approve in the TUI", async () => {
		const ui = scriptedUI(["approve", false]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ status: "answered", outcome: "approved", notes: "", by: "alice", adapter: "in-session" });
		expect(result.status === "answered" && Number.isNaN(Date.parse(result.at))).toBe(false);
		expect(ui.calls[0]).toEqual({
			method: "select",
			title: "Approve define?",
			options: ["approve", "request changes", "dismiss"],
		});
	});

	test("approve with notes is approved_with_notes", async () => {
		const ui = scriptedUI(["approve", true, "looks good"]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ outcome: "approved_with_notes", notes: "looks good" });
	});

	test("cancelled select is dismissed", async () => {
		const ui = scriptedUI([undefined]);
		const result = await createInSessionApprover(ui, login).request(gateRequest());
		expect(result).toMatchObject({ status: "answered", outcome: "dismissed", adapter: "in-session" });
	});

	test("cancelled notes input after approve is dismissed", async () => {
		const ui = scriptedUI(["approve", true, undefined]);
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
		const ui = scriptedUI(["Waive failing checks", false]);
		const request = gateRequest({ options: [{ id: "waive", label: "Waive failing checks" }] });
		const result = await createInSessionApprover(ui, login).request(request);
		expect(ui.calls[0]).toMatchObject({ options: ["approve", "request changes", "dismiss", "Waive failing checks"] });
		expect(result).toMatchObject({ outcome: "approved", choice: "waive" });
	});

	test("question answer goes into answer, and the requirement choice into changesRequirement", async () => {
		const ui = scriptedUI(["answer now", "use per-user limits", "rate-limit/Requirement: Per-IP cap"]);
		const result = await createInSessionApprover(ui, login).request(questionRequest());
		expect(ui.calls[2]).toMatchObject({
			method: "select",
			options: ["no", "rate-limit/Requirement: Per-IP cap", "auth/Requirement: Login", "other"],
		});
		expect(result).toMatchObject({
			status: "answered",
			outcome: "approved",
			answer: "use per-user limits",
			changesRequirement: "rate-limit/Requirement: Per-IP cap",
			questionClass: "blocking",
			adapter: "in-session",
		});
	});

	test("question answer without a requirement change", async () => {
		const ui = scriptedUI(["answer now", "yes", "no"]);
		const result = await createInSessionApprover(ui, login).request(questionRequest());
		expect(result).toMatchObject({ outcome: "approved", answer: "yes" });
		expect(result).not.toHaveProperty("changesRequirement");
	});

	test("question requirement other opens an input", async () => {
		const ui = scriptedUI(["answer now", "yes", "other", "billing/Requirement: Invoices"]);
		const result = await createInSessionApprover(ui, login).request(questionRequest());
		expect(result).toMatchObject({ changesRequirement: "billing/Requirement: Invoices" });
	});

	test("cancelled question answer is dismissed", async () => {
		const ui = scriptedUI(["answer now", undefined]);
		const result = await createInSessionApprover(ui, login).request(questionRequest());
		expect(result).toMatchObject({ outcome: "dismissed" });
	});

	test("answer later returns deferred", async () => {
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
			false,
			true,
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
		expect(ui.calls[2]).toMatchObject({ method: "confirm", title: "Adjust Difficulty or Tags?" });
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
		const ui = scriptedUI(["approve", false, true, undefined]);
		const request = gateRequest({ subject: "gate:plan", overridable: { units: ["U1"] } });
		const result = await createInSessionApprover(ui, login).request(request);
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
			poll: async () => ({ status: "pending" }),
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

	test("poll is always pending", async () => {
		const approver = createInSessionApprover(scriptedUI([]), login);
		expect(approver.name).toBe("in-session");
		await expect(approver.poll("gate-define.abc")).resolves.toEqual({ status: "pending" });
	});
});
