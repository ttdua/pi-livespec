import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { describe, expect, test } from "vitest";
import { currentDecision, type DecisionRecord, decisionComment, formatDecisionBlock, latestDecisions, parseDecisionBlocks, reusableAnswer, validDecisions } from "../../src/decide/records.ts";
import { type MarkedComment, parseMarked } from "../../src/forge/markers.ts";
import { behaviorDigest, latestConclusions } from "../../src/docs/behavior-change.ts";

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

	test("a record without outcome does not replace the latest valid record", () => {
		const { outcome: _o, ...noOutcome } = TAGS_U3;
		const map = latestDecisions([marked("tags.U1", TAGS_U3), marked("tags.U1", noOutcome)]);
		expect(map.get("tags.U1")).toEqual(TAGS_U3);
	});

	test("falsy outcomes are valid records", () => {
		for (const outcome of [false, 0, null, ""]) {
			const record = { ...TAGS_U3, outcome };
			expect(latestDecisions([marked("tags.U1", TAGS_U3), marked("tags.U1", record)]).get("tags.U1")).toEqual(record);
		}
	});

	test("records with mistyped optional fields are skipped", () => {
		const bad: unknown[] = [
			{ ...TAGS_U3, digest: 1 },
			{ ...TAGS_U3, facts_hash: 2 },
			{ ...TAGS_U3, agent_additions: "api" },
			{ ...TAGS_U3, agent_additions: [1] },
			{ ...TAGS_U3, overridden_by: "alice" },
			{ ...TAGS_U3, overridden_by: { by: "alice" } },
			{ ...TAGS_U3, request: 3 },
		];
		for (const data of bad) {
			expect(latestDecisions([marked("tags.U1", TAGS_U3), marked("tags.U1", data)]).get("tags.U1")).toEqual(TAGS_U3);
		}
		const ok = { ...TAGS_U3, overridden_by: { by: "alice", at: "t", from: ["security"] }, request: "r1" };
		expect(latestDecisions([marked("tags.U1", ok)]).get("tags.U1")).toEqual(ok);
	});

	test("PR blocks without outcome or with mistyped fields are ignored", () => {
		const good: DecisionRecord = { point: "lane", subject: "pr-1", source: "rule", outcome: false, reason: "r" };
		const noOutcome = "<!-- livespec:decision:lane -->\n```yaml\npoint: lane\nsubject: pr-1\nsource: rule\nreason: r\n```";
		const badAdditions = "<!-- livespec:decision:lane -->\n```yaml\npoint: lane\nsubject: pr-1\nsource: rule\noutcome: x\nreason: r\nagent_additions: api\n```";
		const body = `${noOutcome}\n\n${badAdditions}\n\n${formatDecisionBlock("lane", good)}\n`;
		expect(parseDecisionBlocks(body)).toEqual([good]);
	});

	test("reusableAnswer hits a human record with the same digest and facts", () => {
		const facts = { files: ["a.ts"] };
		const human: DecisionRecord = { ...TAGS_U3, point: "pick", subject: "U1", digest: "d1", source: "human", outcome: "y", facts, reason: "chosen" };
		expect(reusableAnswer([marked("pick.U1", human)], "pick", "U1", "d1", facts)).toEqual(human);
	});

	test("reusableAnswer misses other digest, other facts, rule source and dismissed outcome", () => {
		const facts = { files: ["a.ts"] };
		const base: DecisionRecord = { ...TAGS_U3, point: "pick", subject: "U1", digest: "d1", source: "human", outcome: "y", facts, reason: "r" };
		const misses: [string, unknown, DecisionRecord][] = [
			["d2", facts, base],
			["d1", { files: ["b.ts"] }, base],
			["d1", facts, { ...base, source: "rule" }],
			["d1", facts, { ...base, outcome: null }],
		];
		for (const [digest, f, record] of misses) {
			expect(reusableAnswer([marked("pick.U1", record)], "pick", "U1", digest, f)).toBeUndefined();
		}
	});

	test("reusableAnswer: latest dismissed wins", () => {
		const facts = { n: 1 };
		const chosen: DecisionRecord = { ...TAGS_U3, point: "pick", subject: "U1", digest: "d1", source: "human", outcome: "y", facts, reason: "r" };
		const dismissed = { ...chosen, outcome: null };
		expect(reusableAnswer([marked("pick.U1", chosen), marked("pick.U1", dismissed)], "pick", "U1", "d1", facts)).toBeUndefined();
	});

	test("reusableAnswer: latest with other facts wins", () => {
		const facts = { n: 1 };
		const older: DecisionRecord = { ...TAGS_U3, point: "pick", subject: "U1", digest: "d1", source: "human", outcome: "x", facts, reason: "r" };
		const newer = { ...older, outcome: "y", facts: { n: 2 } };
		expect(reusableAnswer([marked("pick.U1", older), marked("pick.U1", newer)], "pick", "U1", "d1", facts)).toBeUndefined();
	});

	test("reusableAnswer: a newer rule record stops reuse", () => {
		const facts = { n: 1 };
		const human: DecisionRecord = { ...TAGS_U3, point: "pick", subject: "U1", digest: "d1", source: "human", outcome: "y", facts, reason: "r" };
		const rule = { ...human, source: "rule" as const, reason: "rule" };
		expect(reusableAnswer([marked("pick.U1", human), marked("pick.U1", rule)], "pick", "U1", "d1", facts)).toBeUndefined();
	});

	test("reusableAnswer reuses by facts_hash for large facts", () => {
		const facts = { blob: "x".repeat(2001) };
		const record: DecisionRecord = { ...TAGS_U3, point: "pick", subject: "U1", digest: "d1", source: "human", outcome: "y", facts, reason: "r" };
		const parsed = parseMarked(decisionComment(record)) as MarkedComment;
		expect(reusableAnswer([parsed], "pick", "U1", "d1", facts)).toMatchObject({ outcome: "y", facts_hash: expect.any(String) });
	});

	test("reusableAnswer reuses after a forge round-trip", () => {
		const record: DecisionRecord = { ...TAGS_U3, point: "pick", subject: "U1", digest: "d1", source: "human", outcome: "y", facts: { files: ["a.ts"], tags: ["ui"], n: 3 }, reason: "r" };
		const parsed = parseMarked(decisionComment(record)) as MarkedComment;
		expect(reusableAnswer([parsed], "pick", "U1", "d1", { files: ["a.ts"], tags: ["ui"], n: 3 })).toMatchObject({ outcome: "y" });
	});

	test("Proposal record is not current", () => {
		const facts = { n: 1 };
		const rule: DecisionRecord = { point: "difficulty", subject: "U1", digest: "d1", source: "rule", outcome: "low", facts, reason: "rule" };
		const proposal: DecisionRecord = { ...rule, source: "human", outcome: "high", reason: "chosen by alice", request: "r1", proposal: true };
		const all = [marked("difficulty.U1", rule), marked("difficulty.U1", proposal)];
		expect(currentDecision(all, "difficulty", "U1", "d1")).toEqual(rule);
		expect(reusableAnswer(all, "difficulty", "U1", "d1", facts)).toEqual(proposal);
	});

	test("a proposal flag that is not boolean is skipped", () => {
		expect(latestDecisions([marked("tags.U1", TAGS_U3), marked("tags.U1", { ...TAGS_U3, proposal: "yes" })]).get("tags.U1")).toEqual(TAGS_U3);
	});

	test("malformed decision data is skipped", () => {
		const map = latestDecisions([marked("tags.U1", TAGS_U3), marked("tags.U1", "garbage")]);
		expect(map.get("tags.U1")).toEqual(TAGS_U3);
	});

	test("Behavior files kept with hashed facts", () => {
		const files = Array.from({ length: 300 }, (_, i) => `src/limit/file-${String(i).padStart(3, "0")}.ts`);
		const item = { capability: "rate-limit", files };
		const record: DecisionRecord = { point: "behavior-change", subject: "rate-limit", digest: behaviorDigest(files), source: "human", outcome: "unchanged", facts: item, files, reason: "chosen by alice" };
		const data = parseMarked(decisionComment(record))?.data as DecisionRecord;
		expect(data.facts_hash).toEqual(expect.any(String));
		expect(data).not.toHaveProperty("facts");
		expect(data.files).toHaveLength(300);
		expect(reusableAnswer([marked("behavior-change.rate-limit", data)], "behavior-change", "rate-limit", behaviorDigest(files), item)).toMatchObject({ outcome: "unchanged" });
	});

	test("Agent source only for behavior-change", () => {
		const agentComment = { point: "difficulty", subject: "U1", source: "agent", outcome: "high", reason: "r" };
		expect(validDecisions([marked("difficulty.U1", agentComment)])).toEqual([]);
		const agentBehavior = { point: "behavior-change", subject: "rate-limit", source: "agent", outcome: "unchanged", reason: "r" };
		expect(validDecisions([marked("behavior-change.rate-limit", agentBehavior)])).toHaveLength(1);
	});

	test("files that are not a string list make the record invalid", () => {
		const bad = { point: "behavior-change", subject: "x", source: "human", outcome: "unchanged", reason: "r", files: [1] };
		expect(latestDecisions([marked("behavior-change.x", bad)]).size).toBe(0);
	});

	test("latestBehaviorRecords keeps the latest human non-proposal record per capability", () => {
		const base = (subject: string, outcome: string): DecisionRecord => ({ point: "behavior-change", subject, digest: "d", source: "human", outcome, facts: { capability: subject, files: ["a.ts"] }, files: ["a.ts"], reason: "r" });
		const all = [
			marked("behavior-change.rate-limit", base("rate-limit", "unchanged")),
			marked("behavior-change.rate-limit", base("rate-limit", "changed")),
			marked("behavior-change.auth", { ...base("auth", "unchanged"), source: "rule" }),
			marked("behavior-change.api", { ...base("api", "unchanged"), proposal: true }),
			marked("tags.U1", TAGS_U3),
		];
		const latest = latestConclusions(all);
		expect([...latest.keys()]).toEqual(["rate-limit"]);
		expect(latest.get("rate-limit")?.outcome).toBe("changed");
	});

	test("a newer malformed behavior record does not mask a valid one", () => {
		const valid: DecisionRecord = { point: "behavior-change", subject: "rate-limit", digest: "d", source: "human", outcome: "unchanged", facts: { capability: "rate-limit", files: ["a.ts"] }, files: ["a.ts"], reason: "r" };
		const noReason = { point: "behavior-change", subject: "rate-limit", source: "human", outcome: "changed" };
		const badFiles = { ...valid, outcome: "changed", files: "a.ts" };
		const latest = latestConclusions([marked("behavior-change.rate-limit", valid), marked("behavior-change.rate-limit", noReason), marked("behavior-change.rate-limit", badFiles)]);
		expect(latest.get("rate-limit")).toMatchObject({ outcome: "unchanged", source: "human", reason: "r", files: ["a.ts"] });
	});
});
