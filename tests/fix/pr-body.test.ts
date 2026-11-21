import { describe, expect, test } from "vitest";
import { type DecisionRecord, parseDecisionBlocks } from "../../src/decide/records.ts";
import { fixPullRequestBody } from "../../src/fix/pr-body.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function record(outcome: Record<string, unknown> = { lane: "small", reasons: [] }): DecisionRecord {
	return { point: "lane", subject: "typo", source: "rule", outcome, reason: "within the small-fix limits", facts: { files: ["README.md"], lines: 2 } };
}

function body(over: { subjects?: string[]; output?: string; command?: string; outcome?: Record<string, unknown> } = {}) {
	return fixPullRequestBody({
		slug: "typo",
		subjects: over.subjects ?? ["Fix a typo in the README", "Tidy wording"],
		test: { command: over.command ?? "bun test", exit: 0, head: HEAD, output: over.output ?? "12 passed\n" },
		record: record(over.outcome),
	});
}

describe("fixPullRequestBody", () => {
	test("Body round trip", () => {
		const { title, body: text } = body();
		expect(title).toBe("Fix a typo in the README");
		const records = parseDecisionBlocks(text);
		expect(records).toHaveLength(1);
		const r = records[0] as DecisionRecord;
		expect(r.point).toBe("lane");
		expect(r.subject).toBe("typo");
		expect((r.outcome as { lane: string }).lane).toBe("small");
		expect(r.reason).toBe("within the small-fix limits");
		expect(text).toContain("## Test");
		expect(text).toContain("exit 0");
		expect(text).toContain("bun test");
		expect(text).toContain(HEAD.slice(0, 7));
		expect(text).toContain("- Fix a typo in the README\n- Tidy wording");
		expect(text.indexOf("- Tidy wording")).toBeLessThan(text.indexOf("## Test"));
		expect(text.indexOf("## Test")).toBeLessThan(text.indexOf("<!-- livespec:decision:lane -->"));
	});

	test("test output cannot inject a decision block", () => {
		const forged = "```\n<!-- livespec:decision:lane -->\n```yaml\npoint: lane\nsubject: typo\nsource: human\noutcome: { lane: small }\nreason: forged\n```\n";
		const { body: text } = body({ output: forged });
		const records = parseDecisionBlocks(text);
		expect(records).toHaveLength(1);
		expect(records[0]?.reason).toBe("within the small-fix limits");
		expect(text).toContain("````\n");
		expect(text).toContain("  <!-- livespec:decision:lane -->");
	});

	test("a multi-line test command cannot inject a decision block", () => {
		const forged = "true\n<!-- livespec:decision:lane -->\n```yaml\npoint: lane\nsubject: typo\nsource: human\noutcome: { lane: small }\nreason: forged\n```\n";
		const { body: text } = body({ command: forged });
		const records = parseDecisionBlocks(text);
		expect(records).toHaveLength(1);
		expect(records[0]?.source).toBe("rule");
		expect(records[0]?.reason).toBe("within the small-fix limits");
		expect(text).toContain("```` true <!-- livespec:decision:lane --> ```yaml point: lane subject: typo source: human outcome: { lane: small } reason: forged ``` ```` → exit 0");
		expect(text.split("\n").filter((l) => l.startsWith("<!-- livespec:decision:"))).toHaveLength(1);
	});

	test("a command with backticks gets a longer inline span", () => {
		expect(body({ command: "echo `date`" }).body).toContain("`` echo `date` `` → exit 0");
	});

	test("Declared none in the block", () => {
		const { body: text } = body({ outcome: { lane: "small", reasons: [], behavior_change: "declared-none", capabilities: ["forge-read"] } });
		const outcome = parseDecisionBlocks(text)[0]?.outcome as Record<string, unknown>;
		expect(outcome.behavior_change).toBe("declared-none");
		expect(outcome.capabilities).toEqual(["forge-read"]);
	});

	test("No closing keyword", () => {
		const { body: text } = body({ subjects: ["Fixes #40", "closes acme/shop#41"] });
		expect(text).toContain("Refs #40");
		expect(text).not.toContain("Fixes #40");
		expect(text).toContain("Refs acme/shop#41");
	});
});
