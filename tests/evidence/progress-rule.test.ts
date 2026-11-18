import { Buffer } from "node:buffer";
import { parseDocument, stringify } from "yaml";
import { beforeEach, describe, expect, test } from "vitest";
import { decisionComment } from "../../src/decide/records.ts";
import { registerBuiltinRules, resetRulesForTests, ruleFor } from "../../src/decide/registry.ts";
import { type Decided, decide } from "../../src/decide/seam.ts";
import { PROGRESS_OUTPUT_BYTES, type ProgressFacts, previousSignature, progressRecord } from "../../src/evidence/progress-rule.ts";
import { type Signature, failureSignature } from "../../src/evidence/signature.ts";
import { type MarkedComment, parseMarked } from "../../src/forge/markers.ts";

beforeEach(() => {
	resetRulesForTests();
	registerBuiltinRules();
});

async function run(facts: ProgressFacts): Promise<Decided> {
	const d = await decide("progress", facts, { config: { mode: "rule" }, subject: "U1" });
	if (d.status !== "decided") throw new Error("progress never asks");
	return d;
}

const failA = failureSignature("FAIL t.test.ts > a 12ms\nat /tmp/abc/t.ts\nexpected 1 to be 2");
const failB = failureSignature("FAIL t.test.ts > b 3ms\nexpected 'x' to be 'y'");

function recordInput(signature: Signature, outputTail: string, decided: Decided) {
	return { unit: "U1", digest: "d1", start: "U1.s", attempt: 1, exit: 1, postSha: "b".repeat(40), signature, outputTail, decided };
}

describe("progress rule", () => {
	test("Two identical failures stop early", async () => {
		const second = failureSignature("FAIL t.test.ts > a 40ms\nat /tmp/def/t.ts\nexpected 1 to be 2");
		const d = await run({ attempt: 2, cap: 3, signature: second, previous: failA });
		expect(d.outcome).toBe("stop");
		expect(d.source).toBe("rule");
	});

	test("Different failures retry", async () => {
		expect((await run({ attempt: 2, cap: 3, signature: failB, previous: failA })).outcome).toBe("retry");
	});

	test("relative path suffixes are different failures", async () => {
		const red = failureSignature("AssertionError: expected value left/red");
		const blue = failureSignature("AssertionError: expected value left/blue");
		expect((await run({ attempt: 2, cap: 3, signature: blue, previous: red })).outcome).toBe("retry");
	});

	test("first failure retries", async () => {
		expect((await run({ attempt: 1, cap: 3, signature: failA })).outcome).toBe("retry");
	});

	test("Cap with different failures", async () => {
		const d = await run({ attempt: 3, cap: 3, signature: failA, previous: failB });
		expect(d.outcome).toBe("stop");
		expect(d.reason).toMatch(/cap 3/);
	});

	test("Unrecognized output", async () => {
		const same1 = failureSignature("Error: boom at 10:00:01");
		const same2 = failureSignature("Error: boom at 11:22:33");
		const other = failureSignature("Error: bang");
		expect(same1.tests).toEqual([]);
		expect((await run({ attempt: 2, cap: 3, signature: same2, previous: same1 })).outcome).toBe("stop");
		expect((await run({ attempt: 2, cap: 3, signature: other, previous: same1 })).outcome).toBe("retry");
	});

	test("Large output keeps the signature", async () => {
		const first = await run({ attempt: 1, cap: 3, signature: failA });
		const record = progressRecord(recordInput(failA, "x".repeat(PROGRESS_OUTPUT_BYTES), first));
		expect(stringify(record.facts).length).toBeGreaterThan(2000);
		const parsed = parseMarked(decisionComment(record));
		if (!parsed) throw new Error("unparsable");
		expect(parsed.id).toBe("progress.U1");
		const data = parsed.data as Record<string, unknown>;
		expect(data.facts).toBeUndefined();
		expect(data.facts_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(data.signature).toEqual(failA);
		expect(data.attempt).toBe(1);
		const marked: MarkedComment[] = [{ commentId: "c1", author: "bot", ...parsed }];
		const previous = previousSignature(marked, "U1", -1);
		expect(previous).toEqual(failA);
		expect((await run({ attempt: 2, cap: 3, signature: { ...failA }, previous })).outcome).toBe("stop");
	});

	test("progressRecord caps the output", async () => {
		const d = await run({ attempt: 1, cap: 3, signature: failA });
		const record = progressRecord(recordInput(failA, "é".repeat(3000), d));
		const tail = (record.facts as { output_tail: string }).output_tail;
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(PROGRESS_OUTPUT_BYTES);
		expect(tail.endsWith("é")).toBe(true);
		expect(tail).not.toContain("\uFFFD");
		expect(record).toMatchObject({ point: "progress", subject: "U1", digest: "d1", source: "rule", outcome: "retry", attempt: 1, signature: failA });
		expect(record.facts).toMatchObject({ start: "U1.s", attempt: 1, exit: 1, post_sha: "b".repeat(40), signature: failA });
	});

	test("previousSignature ignores records at or before the window start and other units", () => {
		const rec = (subject: string, sig: Signature): MarkedComment => ({
			commentId: "c",
			author: "bot",
			kind: "decision",
			id: `progress.${subject}`,
			data: { point: "progress", subject, source: "rule", outcome: "retry", reason: "r", signature: sig, attempt: 1 },
		});
		const marked = [rec("U1", failA), rec("U2", failB)];
		expect(previousSignature(marked, "U1", 0)).toBeUndefined();
		expect(previousSignature(marked, "U1", -1)).toEqual(failA);
		expect(previousSignature(marked, "U2", -1)).toEqual(failB);
	});

	test("decisions.progress accepts only mode", () => {
		const errors: string[] = [];
		const doc = parseDocument("mode: rule\nextra: 1\n");
		ruleFor("progress")?.schema.validate(doc.contents, (_n, msg) => errors.push(msg));
		expect(errors).toEqual(["unknown key `extra` in `decisions.progress`; allowed: mode"]);
	});
});
