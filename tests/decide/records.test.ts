import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { describe, expect, test } from "vitest";
import { type DecisionRecord, decisionComment, formatDecisionBlock, latestDecisions, parseDecisionBlocks } from "../../src/decide/records.ts";
import { type MarkedComment, parseMarked } from "../../src/forge/markers.ts";

const TAGS_U3: DecisionRecord = {
	point: "tags",
	subject: "U3",
	digest: "abc123",
	source: "rule",
	outcome: ["security", "api"],
	facts: { title: "Login", files: ["src/auth/login.ts"] },
	reason: "rule: security (file src/auth/login.ts matches **/auth/**); agent added: api",
	agent_additions: ["api"],
};

function marked(id: string, data: unknown, kind = "decision"): MarkedComment {
	return { commentId: `c-${id}-${String((data as { outcome?: unknown }).outcome)}`, kind, id, author: "bot", data };
}

describe("decision records", () => {
	test("Record fields", () => {
		const parsed = parseMarked(decisionComment(TAGS_U3));
		expect(parsed).toMatchObject({ kind: "decision", id: "tags.U3" });
		expect(parsed?.data).toEqual(TAGS_U3);
		expect(parsed?.data).toMatchObject({ source: "rule", outcome: ["security", "api"], agent_additions: ["api"] });
	});

	test("Large facts hashed", () => {
		const facts = { blob: "x".repeat(2001) };
		const yaml = stringify(facts);
		expect(yaml.length).toBeGreaterThan(2000);
		const data = parseMarked(decisionComment({ ...TAGS_U3, facts }))?.data as DecisionRecord;
		expect(data.facts_hash).toBe(createHash("sha256").update(yaml).digest("hex"));
		expect(data).not.toHaveProperty("facts");
	});

	test("facts at the limit are kept", () => {
		const facts = { blob: "x".repeat(1990) };
		expect(stringify(facts).length).toBeLessThanOrEqual(2000);
		const data = parseMarked(decisionComment({ ...TAGS_U3, facts }))?.data as DecisionRecord;
		expect(data.facts).toEqual(facts);
		expect(data).not.toHaveProperty("facts_hash");
	});

	test("Round trip in a PR body", () => {
		const record: DecisionRecord = { point: "lane", subject: "pr-12", source: "rule", outcome: "small-fix", facts: { files: 1 }, reason: "one file" };
		const body = `Fixes a typo.\n\n${formatDecisionBlock("lane", record)}\n\n<!-- livespec:decision:other -->\nnot yaml\n\nThanks!\n`;
		expect(formatDecisionBlock("lane", record).split("\n")[0]).toBe("<!-- livespec:decision:lane -->");
		expect(parseDecisionBlocks(body)).toEqual([record]);
	});

	test("PR block parsing keeps CRLF bodies", () => {
		const record: DecisionRecord = { point: "lane", subject: "pr-1", source: "human", outcome: "full", reason: "r" };
		const body = `intro\r\n${formatDecisionBlock("lane", record).replace(/\n/g, "\r\n")}\r\n`;
		expect(parseDecisionBlocks(body)).toEqual([record]);
	});

	test("latest record per id wins", () => {
		const first = { ...TAGS_U3, outcome: ["security"] };
		const second = { ...TAGS_U3, source: "human", outcome: ["security", "ui"] };
		const other = { ...TAGS_U3, point: "difficulty", subject: "U3", outcome: "high" };
		const map = latestDecisions([
			marked("tags.U3", first),
			marked("difficulty.U3", other),
			marked("tags.U3", { not: "a record" }, "gate"),
			marked("tags.U3", second),
		]);
		expect([...map.keys()]).toEqual(["tags.U3", "difficulty.U3"]);
		expect(map.get("tags.U3")).toEqual(second);
		expect(map.get("difficulty.U3")).toEqual(other);
	});

	test("malformed decision data is skipped", () => {
		const map = latestDecisions([marked("tags.U1", TAGS_U3), marked("tags.U1", "garbage")]);
		expect(map.get("tags.U1")).toEqual(TAGS_U3);
	});
});
