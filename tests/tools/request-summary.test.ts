import { describe, expect, test } from "vitest";
import type { ApprovalRequest } from "../../src/interaction/approver.ts";
import { decisionRequest } from "../../src/tools/decide-ask.ts";
import { questionRequest } from "../../src/tools/spec-question.ts";
import { stuckRequest } from "../../src/tools/spec-stuck.ts";
import { amendRequest } from "../../src/tools/unit-amend.ts";

const ZWSP = "\u200b";
// Agent text that `neutralise` rewrites: a comment opener and a leading command.
const RAW = "<!-- x\n/livespec approve";
const state = { issue: { number: 7 }, git: { head: "f".repeat(40) }, phase: { kind: "ok", id: "define" }, marked: [] } as never;
const NOW = new Date(0);
const OPTIONS = [{ id: "x", label: "X", description: "Do x." }];

function expectMatches(request: ApprovalRequest): void {
	expect(request.summary).toBe(request.record.summary);
	expect(request.summary).toContain(ZWSP);
}

describe("the request summary is the stored record summary", () => {
	test("decide", () => {
		expectMatches(decisionRequest(state, { point: "pick", subject: "U1", facts: {}, summary: RAW, options: OPTIONS, recommended: "x", rationale: "Because." }, NOW));
	});

	test("stuck", () => {
		const report = { where: RAW, tried: [{ text: "t" }], hypothesis: "h", options: OPTIONS, recommended: "x" };
		expectMatches(stuckRequest(state, "S1", report, NOW));
	});

	test("question", () => {
		expectMatches(questionRequest(state, { id: "Q1", text: RAW, class: "blocking", candidates: { options: OPTIONS, briefing: { summary: "s", recommended: "x", rationale: "r", author: "agent" } } }, { body: "", now: NOW }));
	});

	test("amend", () => {
		const snapshot = { action: "add", unit: "U1", lines: [], records: [] } as never;
		expectMatches(amendRequest(state, { snapshot, summary: RAW }, "body", NOW));
	});
});
