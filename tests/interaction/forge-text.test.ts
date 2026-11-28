import { describe, expect, test } from "vitest";
import type { ApprovalRequest, Briefing, RequestKind, RequestOption, RequestSnapshot, Subject } from "../../src/interaction/approver.ts";
import { parseCommand } from "../../src/interaction/commands.ts";
import { gateChoices, offeredChoiceIds } from "../../src/interaction/describe-actions.ts";
import { renderForgeRequest } from "../../src/interaction/forge-text.ts";
import { prepareRequest } from "../../src/interaction/requests.ts";
import { contractFields } from "../helpers/briefing.ts";

const HEAD = "f".repeat(40);
const NOW = new Date("2026-01-01T00:00:00.000Z");
const AGENT_HEADING = "Agent recommendation (agent-authored, advisory)";

type Spec = {
	subject: Subject;
	kind?: RequestKind;
	options?: RequestOption[];
	briefing?: Briefing;
	snapshot?: RequestSnapshot;
	summary?: string;
	files?: string[];
	links?: string[];
	change?: number;
};

function request(s: Spec): ApprovalRequest {
	const kind = s.kind ?? "gate";
	const snapshot = s.snapshot ?? { target: s.subject.slice("gate:".length), failingWaivable: [] };
	const fields = contractFields(kind, s.subject, snapshot, s.options);
	const briefing = { ...fields.briefing, ...s.briefing };
	const record = prepareRequest({
		kind,
		subject: s.subject,
		mode: "blocking",
		...(fields.options ? { options: fields.options } : {}),
		briefing,
		head: HEAD,
		body: "body",
		snapshot,
		summary: s.summary ?? `Review ${s.subject}`,
		now: NOW,
	});
	return {
		id: record.id,
		kind,
		subject: s.subject,
		record,
		change: s.change ?? 7,
		phase: "define",
		summary: record.summary,
		links: s.links ?? [],
		files: s.files ?? [],
		mode: "blocking",
		...(fields.options ? { options: fields.options } : {}),
		briefing,
	};
}

const WAIVE = { id: "waive", label: "Waive size-limits" };
const failingPlan = (briefing?: Briefing) =>
	request({ subject: "gate:plan", options: [WAIVE], snapshot: { target: "plan", failingWaivable: ["size-limits"] }, ...(briefing ? { briefing } : {}) });

const QUESTION: Spec = {
	subject: "question:Q2",
	kind: "question",
	snapshot: { id: "Q2", text: "Which limit?" },
	summary: "Which limit?",
	options: [
		{ id: "A", label: "per-user limits", description: "One budget per account." },
		{ id: "B", label: "per-IP limits", description: "One budget per client address." },
	],
	briefing: { summary: "Which limit?", recommended: "A", rationale: "Accounts are stable.", author: "agent" },
};

/** The table rows (lines starting with `|`) of the How to answer section. */
function answerRows(text: string): string[] {
	const section = text.slice(text.indexOf("### How to answer"), text.indexOf("<details>"));
	return section.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Choice") && !l.startsWith("| ---"));
}

/** The command of the row whose first cell contains `label`, code span and table escapes removed. */
function commandOf(text: string, label: string): string {
	const row = answerRows(text).find((r) => r.split(" | ")[0]?.includes(label)) ?? "";
	const code = /`+ ?(.*?) ?`+ \|$/.exec(row)?.[1] ?? "";
	return code.replaceAll("\\|", "|");
}

describe("offeredChoiceIds", () => {
	test("gate offers approve, changes, dismiss, then options with waive once", () => {
		expect(offeredChoiceIds({ kind: "gate", options: [{ id: "x", label: "x" }] })).toEqual(["approve", "changes", "dismiss", "x"]);
		expect(offeredChoiceIds({ kind: "gate", options: [{ id: "x", label: "x" }, WAIVE, WAIVE], failingWaivable: ["size-limits"] })).toEqual(["changes", "dismiss", "waive", "x"]);
	});

	test("amend offers the built-ins only; choice offers its options", () => {
		expect(offeredChoiceIds({ kind: "amend", options: [{ id: "x", label: "x" }] })).toEqual(["approve", "changes", "dismiss"]);
		expect(offeredChoiceIds({ kind: "choice", options: [{ id: "A", label: "a" }, { id: "B", label: "b" }] })).toEqual(["A", "B"]);
	});
});

describe("gateChoices", () => {
	test("Plan approve described", () => {
		const approve = gateChoices(request({ subject: "gate:plan" })).find((c) => c.id === "approve");
		expect(approve).toEqual({ id: "approve", label: "approve", description: "Lock the unit digests; the change moves to build.", command: "/livespec approve [notes]" });
	});

	test("define, ship and named gates have fixed approve descriptions", () => {
		const approve = (subject: Subject) => gateChoices(request({ subject })).find((c) => c.id === "approve")?.description;
		expect(approve("gate:define")).toBe("Accept the spec; the change moves to plan.");
		expect(approve("gate:ship")).toBe("Accept the ship packet; change_ship can then run.");
		expect(approve("gate:new-dependency")).toBe("Same as option A: create the prerequisite change and park this one until it merges.");
		expect(approve("gate:initiative")).toBe("Accept; the gate's effects are applied.");
		const amend = request({ subject: "amend:2", snapshot: { action: "drop", unit: "U9", records: [] } });
		expect(gateChoices(amend).find((c) => c.id === "approve")?.description).toBe("Accept; the gate's effects are applied.");
	});

	test("Waive lists the checks", () => {
		const choices = gateChoices(failingPlan());
		expect(choices.map((c) => c.id)).toEqual(["changes", "dismiss", "waive"]);
		expect(choices.find((c) => c.id === "waive")).toMatchObject({ description: "Approve and waive the failing checks: size-limits.", command: "/livespec choose waive [notes]" });
		expect(choices.find((c) => c.id === "changes")?.command).toBe("/livespec changes <notes>");
		expect(choices.find((c) => c.id === "dismiss")?.command).toBe("/livespec dismiss [notes]");
	});

	test("stuck options are chosen by id", () => {
		const stuck = request({ subject: "stuck:S1", kind: "stuck", snapshot: { id: "S1" }, options: [{ id: "A", label: "retry", description: "Try once more." }] });
		expect(gateChoices(stuck)).toEqual([{ id: "A", label: "retry", description: "Try once more.", command: "/livespec choose A [notes]" }]);
	});
});

describe("renderForgeRequest", () => {
	test("Gate comment structure", () => {
		const briefing: Briefing = { summary: "The spec is small.", recommended: "approve", rationale: "All checks pass.", author: "agent" };
		const text = renderForgeRequest(
			request({ subject: "gate:define", briefing, summary: "Proposal: limit.\nSpec diff: +1", files: ["specs/rate/spec.md"], links: ["https://forge.example/o/r/issues/7"] }),
		);
		const order = [
			"## Decision needed: approve the define gate on #7",
			"Proposal: limit.",
			"Files:\n- specs/rate/spec.md",
			"Links:\n- https://forge.example/o/r/issues/7",
			AGENT_HEADING,
			"> The spec is small.",
			"### How to answer",
			"<details>",
			"</details>",
		].map((s) => text.indexOf(s));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		const approve = answerRows(text).find((r) => r.includes("/livespec approve"));
		expect(approve).toContain("(recommended)");
		expect(answerRows(text).filter((r) => r.includes("(recommended)"))).toHaveLength(1);
		expect(text.slice(text.indexOf("<details>"))).toContain("/livespec changes <notes>");
	});

	test("Facts before the briefing", () => {
		const text = renderForgeRequest(failingPlan({ summary: "Plan is fine.", author: "agent" }));
		const checks = text.indexOf("| `size-limits` |");
		expect(checks).toBeGreaterThan(0);
		expect(checks).toBeLessThan(text.indexOf(AGENT_HEADING));
	});

	test("Rule briefing not labelled as agent", () => {
		const options = [
			{ id: "x", label: "x" },
			{ id: "y", label: "y" },
		];
		const r = request({ subject: "decide:tags.U1", kind: "stuck", snapshot: { point: "tags", subject: "U1", facts: {} }, options, briefing: { summary: "Pick one.", recommended: "x", rationale: "Rule says x.", author: "rule" } });
		const text = renderForgeRequest(r);
		expect(text).toContain("### Livespec rule recommendation");
		expect(text.toLowerCase()).toContain("livespec rule");
		expect(text).not.toContain("agent-authored");
		expect(answerRows(text).find((row) => row.includes("/livespec choose x"))).toContain("(recommended)");
	});

	test("Question candidates as commands", () => {
		const text = renderForgeRequest(request(QUESTION));
		expect(text).toContain("## Decision needed: answer question Q2 on #7");
		expect(commandOf(text, "per-user limits")).toBe("/livespec answer Q2 per-user limits");
		expect(commandOf(text, "per-IP limits")).toBe("/livespec answer Q2 per-IP limits");
		expect(answerRows(text).find((r) => r.includes("per-user limits"))).toContain("(recommended)");
	});

	test("recommended row first", () => {
		const options = [
			{ id: "A", label: "per-user limits" },
			{ id: "B", label: "per-IP limits" },
		];
		const stuck = request({ subject: "decide:tags.U1", kind: "stuck", snapshot: { point: "tags", subject: "U1", facts: {} }, options, briefing: { summary: "Pick one.", recommended: "B", rationale: "Rule says B.", author: "rule" } });
		const stuckRows = answerRows(renderForgeRequest(stuck));
		expect(stuckRows[0]).toContain("/livespec choose B");
		expect(stuckRows[0]).toContain("(recommended)");
		const questionRows = answerRows(renderForgeRequest(request({ ...QUESTION, briefing: { summary: "Which limit?", recommended: "B", rationale: "IP is stable.", author: "agent" } })));
		expect(questionRows[0]).toContain("per-IP limits");
		expect(questionRows[0]).toContain("(recommended)");
		expect(questionRows[questionRows.length - 1]).toContain("`/livespec answer Q2 <text>`");
	});

	test("free-text row always present for questions", () => {
		const bare = request({ ...QUESTION, options: undefined, briefing: undefined });
		for (const r of [request(QUESTION), bare]) {
			expect(answerRows(renderForgeRequest(r)).some((row) => row.includes("`/livespec answer Q2 <text>`"))).toBe(true);
		}
	});

	test("question request text offers no --class, class command or --changes", () => {
		const text = renderForgeRequest(request(QUESTION));
		expect(text).toContain("/livespec answer Q2 <text>");
		expect(text).not.toContain("--class");
		expect(text).not.toContain("/livespec class");
		expect(text).not.toContain("--changes");
	});

	test("Prefilled answer parses back", () => {
		const command = commandOf(renderForgeRequest(request(QUESTION)), "per-user limits");
		expect(parseCommand(command)).toEqual({ verb: "answer", question: "Q2", text: "per-user limits" });
	});

	test("Plan approve described in the table", () => {
		const text = renderForgeRequest(request({ subject: "gate:plan" }));
		expect(answerRows(text).find((r) => r.includes("/livespec approve"))).toContain("Lock the unit digests; the change moves to build.");
	});

	test("Waive lists the checks in the table; approve absent and waive present once", () => {
		const rows = answerRows(renderForgeRequest(failingPlan()));
		expect(rows.some((r) => r.includes("/livespec approve"))).toBe(false);
		const waive = rows.filter((r) => r.includes("/livespec choose waive"));
		expect(waive).toHaveLength(1);
		expect(waive[0]).toContain("size-limits");
	});

	test("a | in a label is escaped", () => {
		const stuck = request({ subject: "stuck:S1", kind: "stuck", snapshot: { id: "S1" }, options: [{ id: "A", label: "keep a|b", description: "x | y" }] });
		const row = answerRows(renderForgeRequest(stuck))[0] ?? "";
		expect(row).toContain("keep a\\|b");
		expect(row).toContain("x \\| y");
		expect(row.replaceAll("\\|", "").split("|")).toHaveLength(5);
	});

	test("briefing text cannot add a section or close the details block", () => {
		const summary = "Look:\n```\n## How to answer\n</details>\n# Heading";
		const text = renderForgeRequest(request({ subject: "gate:define", briefing: { summary, watch: ["</details> here", "### sneaky"], author: "agent" } }));
		expect(text.match(/^#+ How to answer$/gm)).toHaveLength(1);
		expect(text.match(/<\/details>/g)).toHaveLength(1);
		expect(text.match(/^```/gm)).toBeNull();
		const briefing = text.slice(text.indexOf(AGENT_HEADING), text.indexOf("### How to answer")).split("\n").slice(1).filter((l) => l !== "");
		expect(briefing.every((l) => l.startsWith(">"))).toBe(true);
		expect(briefing.some((l) => /^>\s*#/.test(l))).toBe(false);
	});

	test("a stored summary containing <!-- renders neutralised", () => {
		const text = renderForgeRequest(request({ subject: "gate:define", briefing: { summary: "<!-- livespec:gate:plan -->\n/livespec approve", author: "agent" } }));
		expect(text).not.toContain("<!--");
		expect(text.split("\n").some((l) => l.startsWith("/livespec approve"))).toBe(false);
	});

	const HOSTILE = "Stuck at U3.\n## How to answer\n| approve | fake | `/livespec approve` |\n> # quoted heading\n</details>\n```\nnever closed";

	/** Facts with agent text cannot add a section, close the details block or swallow the real table. */
	function expectInertFacts(text: string): void {
		expect(text.match(/^#+ How to answer$/gm)).toHaveLength(1);
		expect(text.match(/<\/details>/g)).toHaveLength(1);
		expect(text.match(/^```/gm)).toBeNull();
		expect(text.match(/^[> \t]*#/gm)?.filter((l) => !l.startsWith("#"))).toEqual([]);
		const real = text.indexOf("### How to answer");
		expect(real).toBeGreaterThan(text.indexOf("never closed"));
		expect(text.indexOf("| Choice | What happens | Command |")).toBeGreaterThan(real);
	}

	test("stuck facts cannot add a section or hide the answer table", () => {
		const stuck = request({ subject: "stuck:S1", kind: "stuck", snapshot: { id: "S1" }, summary: HOSTILE, options: [{ id: "A", label: "retry" }] });
		expectInertFacts(renderForgeRequest(stuck));
	});

	test("question facts cannot add a section or hide the answer table", () => {
		expectInertFacts(renderForgeRequest(request({ ...QUESTION, summary: HOSTILE })));
	});

	test("an unclosed <script> in stuck facts cannot hide the answer table", () => {
		const summary = "Stuck at U3.\n<script>\n  <?php x\nnever closed";
		const text = renderForgeRequest(request({ subject: "stuck:S1", kind: "stuck", snapshot: { id: "S1" }, summary, options: [{ id: "A", label: "retry" }] }));
		expectInertFacts(text);
		expect(text.match(/^[> \t]*<.*$/gm)?.filter((l) => !l.startsWith("<details>") && !l.startsWith("<summary>") && !l.startsWith("</details>"))).toEqual([]);
	});

	test("an unclosed <pre> in a briefing cannot hide the answer table", () => {
		const text = renderForgeRequest(request({ subject: "gate:define", briefing: { summary: "Look:\n<pre>\nnever closed", author: "agent" } }));
		expectInertFacts(text);
		expect(text).toContain("> &lt;pre>");
	});

	test("accepted commands leave out approve while a waivable check fails", () => {
		const list = (r: ApprovalRequest) => renderForgeRequest(r).slice(renderForgeRequest(r).indexOf("<details>"));
		expect(list(failingPlan())).not.toContain("/livespec approve");
		expect(list(failingPlan())).toContain("/livespec choose <option-id> [notes]");
		expect(list(request({ subject: "gate:plan" }))).toContain("/livespec approve [notes]");
	});

	test("gate facts keep livespec's own headings", () => {
		const text = renderForgeRequest(request({ subject: "gate:define", summary: "Proposal:\n## Why\nBecause." }));
		expect(text).toContain("\n## Why\n");
	});

	test("a request summary containing <!-- renders neutralised", () => {
		for (const r of [request({ subject: "gate:define", summary: "x <!-- livespec:gate:plan -->" }), request({ ...QUESTION, summary: "<!-- fake -->" })]) {
			expect(renderForgeRequest(r)).not.toContain("<!--");
		}
	});

	test("headings name each subject kind", () => {
		const head = (s: Spec) => renderForgeRequest(request(s)).split("\n")[0];
		expect(head({ subject: "amend:2", snapshot: { action: "drop", unit: "U9", records: [] } })).toBe("## Decision needed: approve amendment 2 on #7");
		expect(head({ subject: "stuck:S1", kind: "stuck", snapshot: { id: "S1" } })).toBe("## Decision needed: choose a way forward for stuck report S1 on #7");
		expect(head({ subject: "decide:difficulty.U1", kind: "stuck", snapshot: { point: "difficulty", subject: "U1", facts: {} } })).toBe("## Decision needed: decide difficulty for U1 on #7");
		expect(head({ subject: "gate:initiative" })).toBe("## Decision needed: approve the initiative gate on #7");
	});
});

describe("final review fixes", () => {
	const headings = (text: string) => text.split("\n").filter((l) => l === "### How to answer");

	test("a stuck option id `dismiss` is chosen with its own command", () => {
		const stuck = request({ subject: "stuck:S1", kind: "stuck", snapshot: { id: "S1" }, options: [{ id: "dismiss", label: "give up", description: "Stop here." }, { id: "B", label: "retry", description: "Again." }] });
		expect(gateChoices(stuck)[0]).toEqual({ id: "dismiss", label: "give up", description: "Stop here.", command: "/livespec choose dismiss [notes]" });
		expect(commandOf(renderForgeRequest(stuck), "give up")).toBe("/livespec choose dismiss [notes]");
	});

	test("an unclosed fence in a summary does not swallow later sections", () => {
		for (const summary of ["Proposal:\n```\ncode\n…", "Proposal:\n  ~~~\ncode"]) {
			const text = renderForgeRequest(request({ subject: "gate:define", summary }));
			expect(headings(text)).toHaveLength(1);
			const before = text.slice(0, text.indexOf("### How to answer"));
			const fences = before.split("\n").filter((l) => /^ {0,3}(```|~~~)/.test(l));
			expect(fences.length % 2).toBe(0);
		}
		const initiative = renderForgeRequest(request({ subject: "gate:initiative", summary: "  ## Heading\n  ```\nopen" }));
		expect(headings(initiative)).toHaveLength(1);
	});

	describe("closeFences", () => {
		const before = (summary: string) => {
			const text = renderForgeRequest(request({ subject: "gate:define", summary }));
			expect(headings(text)).toHaveLength(1);
			return text.slice(text.indexOf("### Review"), text.indexOf(`### ${AGENT_HEADING}`));
		};

		test("a quoted fence is not counted, so an unquoted open fence is still closed", () => {
			const out = before("a\n> ```\nb\n```\nopen");
			expect(out.trimEnd().endsWith("open\n```")).toBe(true);
		});

		test("a quoted fence alone adds no closing fence", () => {
			expect(before("x\n> ```\ny")).not.toMatch(/\n```\s*$/);
		});

		test("a fence closes only with its own character", () => {
			const out = before("~~~\ncode\n```\nmore");
			expect(out.trimEnd().endsWith("more\n~~~")).toBe(true);
		});

		test("a shorter fence does not close a longer one, and the closer repeats the opening length", () => {
			const out = before("````\ncode\n```\nmore");
			expect(out.trimEnd().endsWith("more\n````")).toBe(true);
		});

		test("a longer fence closes a shorter one", () => {
			const out = before("```\ncode\n`````\nafter");
			expect(out.trimEnd().endsWith("after")).toBe(true);
		});
	});

	test("the briefing shows the recommended label and separate paragraphs", () => {
		const text = renderForgeRequest(failingPlan({ summary: "S", recommended: "waive", rationale: "Because.", author: "agent" }));
		expect(text).toContain("> Recommended: Waive size-limits\n>\n> Rationale: Because.");
		expect(text).not.toContain("Recommended: waive");
	});
});

describe("every request kind carries a recommendation", () => {
	const cases: [string, Spec][] = [
		["gate", { subject: "gate:define" }],
		["amendment", { subject: "amend:1" }],
		["question", { subject: "question:Q1", kind: "question", snapshot: { id: "Q1", text: "Which store?" }, options: [{ id: "A", label: "Redis", description: "Keep counters in Redis." }, { id: "B", label: "Postgres", description: "Keep counters in Postgres." }] }],
		["stuck report", { subject: "stuck:S1", kind: "stuck", snapshot: { id: "S1" } }],
		["rule ask", { subject: "decide:tags.U1", kind: "stuck", snapshot: { point: "tags", subject: "U1", facts: {} } }],
	];

	test.each(cases)("%s has a briefing with recommended and rationale, the recommended row first", (_name, spec) => {
		const r = request(spec);
		expect(r.briefing?.recommended).toBeDefined();
		expect(r.briefing?.rationale).toBeDefined();
		const text = renderForgeRequest(r);
		expect(text).toContain("Recommended:");
		expect(text).toContain("Rationale:");
		const rows = text.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Choice") && !l.startsWith("| ---"));
		if (rows.length > 0) expect(rows[0]).toContain("(recommended)");
	});
});

describe("behavior override text", () => {
	const items = [{ capability: "rate-limit", outcome: "unchanged" as const }];
	const define = (over: Partial<ApprovalRequest> = {}) => ({ ...request({ subject: "gate:define", summary: "Define\n\nBehavior conclusions (please check):\n- rate-limit: unchanged (agent) — x; files: 1" }), ...over });

	test("the Behavior conclusions section comes before the briefing", () => {
		const text = renderForgeRequest(define({ overridableBehavior: { items } }));
		const section = text.indexOf("Behavior conclusions (please check):");
		expect(section).toBeGreaterThan(-1);
		expect(section).toBeLessThan(text.indexOf("Agent recommendation"));
	});
});
