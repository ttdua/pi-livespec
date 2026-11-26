import { describe, expect, test } from "vitest";
import type { ApprovalRequest } from "../../src/interaction/approver.ts";
import { BRIEFING_HEADING, briefingLines, ENTRY_LABELS, menuEntries, orderRecommended, titleWithBriefing } from "../../src/interaction/menu.ts";

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
	id: "gate-plan.abc",
	kind: "gate",
	subject: "gate:plan",
	record: { id: "gate-plan.abc", kind: "gate", subject: "gate:plan", mode: "blocking", head_sha: "d", snapshot: { target: "plan", failingWaivable: [] }, summary: "Approve plan?" },
	change: 1,
	phase: "plan",
	summary: "Approve plan?",
	links: [],
	files: [],
	mode: "blocking",
	...over,
});

describe("menuEntries", () => {
	const choices = [
		{ id: "a", label: "A", description: "first", value: 1 },
		{ id: "b", label: "B", value: 2 },
		{ id: "c", label: "C", description: "third", value: 3 },
	];

	test("labels carry the description, no id suffix", () => {
		expect(menuEntries(choices).map(([label]) => label)).toEqual(["A — first", "B", "C — third"]);
	});

	test("the recommended entry is first and marked", () => {
		expect(menuEntries(choices, "c")).toEqual([
			["C — third (Recommended)", 3],
			["A — first", 1],
			["B", 2],
		]);
	});

	test("an unknown recommendation changes nothing", () => {
		expect(menuEntries(choices, "zzz").map(([label]) => label)).toEqual(["A — first", "B", "C — third"]);
	});
});

describe("titleWithBriefing", () => {
	test("without a briefing the title is the summary", () => {
		expect(titleWithBriefing(request())).toBe("Approve plan?");
	});

	test("facts come before the briefing", () => {
		const title = titleWithBriefing(
			request({ briefing: { summary: "Looks fine.", watch: ["size"], recommended: "approve", rationale: "All green.", author: "agent" } }),
			"approve",
		);
		expect(title.startsWith("Approve plan?\n\n")).toBe(true);
		expect(title).toContain("Agent recommendation (agent-authored, advisory)");
		expect(title).toMatch(/Looks fine\.[\s\S]*Watch:\n- size[\s\S]*Recommended: approve[\s\S]*Why: All green\./);
	});

	test("agent text is neutralised", () => {
		const title = titleWithBriefing(request({ briefing: { summary: "<!-- x -->", author: "agent" } }));
		expect(title).not.toContain("<!--");
	});
});

describe("gate with a waive recommendation", () => {
	test("waive is first and approve absent", async () => {
		const { createInSessionApprover } = await import("../../src/interaction/in-session.ts");
		const base = request();
		const r = request({
			options: [{ id: "waive", label: "Waive size-limits" }],
			record: { ...base.record, snapshot: { target: "plan", failingWaivable: ["size-limits"] } },
			briefing: { summary: "Accept the size.", recommended: "waive", rationale: "Known.", author: "agent" },
		});
		let seen: string[] = [];
		const ui = {
			hasUI: true,
			select: async (_t: string, options: string[]) => {
				seen = options;
				return undefined;
			},
			input: async () => undefined,
		};
		await createInSessionApprover(ui, async () => "a").request(r);
		expect(seen[0]).toMatch(/^Waive size-limits — .* \(Recommended\)$/);
		expect(seen.some((o) => o.startsWith("approve"))).toBe(false);
	});
});

describe("orderRecommended", () => {
	const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

	test("moves the recommended item first, keeping the rest in order", () => {
		expect(orderRecommended(items, "c").map((i) => i.id)).toEqual(["c", "a", "b"]);
	});

	test("an unknown or missing recommendation changes nothing", () => {
		expect(orderRecommended(items, "zzz")).toEqual(items);
		expect(orderRecommended(items)).toEqual(items);
	});
});

describe("briefingLines", () => {
	test("heading, summary, watch, recommended label and rationale", () => {
		const lines = briefingLines({ summary: "S", watch: ["w1"], recommended: "b", rationale: "R", author: "agent" }, "Bee");
		expect(lines).toEqual([BRIEFING_HEADING.agent, "S", "Watch:", "- w1", "Recommended: Bee", "Why: R"]);
	});

	test("a rule briefing has the rule heading and falls back to the id", () => {
		expect(briefingLines({ summary: "S", recommended: "b", author: "rule" })).toEqual([BRIEFING_HEADING.rule, "S", "Recommended: b"]);
	});
});

describe("ENTRY_LABELS", () => {
	test("question entry labels", () => {
		expect(ENTRY_LABELS).toEqual({ own: "write my own answer", later: "answer later (non-blocking)", answerNow: "answer now" });
	});
});

describe("in-session neutralisation", () => {
	const ZWSP = "\u200b";

	test("the whole title is neutralised, with and without a briefing", () => {
		const raw = "<!-- x\n/livespec approve";
		const safe = `<!-${ZWSP}- x\n${ZWSP}/livespec approve`;
		expect(titleWithBriefing(request({ summary: raw }))).toBe(safe);
		const briefed = titleWithBriefing(request({ summary: raw, briefing: { summary: "b", author: "agent" } }));
		expect(briefed.startsWith(`${safe}\n\n`)).toBe(true);
	});

	test("every entry label is neutralised", () => {
		const [entry] = menuEntries([{ id: "a", label: "/livespec approve", description: "<!-- d", value: 1 }]);
		expect(entry?.[0]).toBe(`${ZWSP}/livespec approve — <!-${ZWSP}- d`);
	});
});
