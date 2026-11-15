import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { answerQuestion, appendQuestion, reclassifyQuestion } from "../../src/core/question-lines.ts";

const body = readFileSync(new URL("../fixtures/change-body.md", import.meta.url), "utf8");
const crlf = body.replace(/\n/g, "\r\n");

function changedLines(a: string, b: string): number[] {
	const x = a.split("\n");
	const y = b.split("\n");
	expect(y).toHaveLength(x.length);
	return x.flatMap((l, i) => (l === y[i] ? [] : [i]));
}

describe("question lines", () => {
	it("Answer written back", () => {
		const out = answerQuestion(body, "Q1", "blocking", "use 60s windows");
		expect(changedLines(body, out)).toHaveLength(1);
		expect(out).toContain(
			"- [x] Q1 (blocking): Which header carries the client IP behind the proxy? — Answer: use 60s windows\n",
		);
		const q = parseChange(out).questions[0]!;
		expect(q).toMatchObject({ checked: true, answer: "use 60s windows", kind: "blocking" });
	});

	it("answer line rewrite keeps CRLF endings", () => {
		const out = answerQuestion(crlf, "Q1", "blocking", "x");
		expect(out).toContain("— Answer: x\r\n");
		expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
	});

	it("answer may change the class", () => {
		const out = answerQuestion(body, "Q1", "non-blocking", "x");
		expect(parseChange(out).questions[0]!.kind).toBe("non-blocking");
	});

	it("append numbers after the highest Q", () => {
		const { body: out, id } = appendQuestion(body, "non-blocking", "Which store?");
		expect(id).toBe("Q3");
		const qs = parseChange(out).questions;
		expect(qs.map((q) => q.id)).toEqual(["Q1", "Q2", "Q3"]);
		expect(qs[2]).toMatchObject({ kind: "non-blocking", text: "Which store?", checked: false });
		expect(out).toContain("Q3 (non-blocking): Which store?\n\n## Units");
		const c = appendQuestion(crlf, "blocking", "Why?").body;
		expect(c.split("\n").every((l, i, a) => i === a.length - 1 || l.endsWith("\r"))).toBe(true);
	});

	it("append creates the Questions section in canonical order", () => {
		const bare = "Base: abc\n\n## Proposal\nP\n\n## Units\n### U1 — T\n- [ ] pending\n";
		const { body: out, id } = appendQuestion(bare, "blocking", "Why?");
		expect(id).toBe("Q1");
		expect(out.indexOf("## Proposal")).toBeLessThan(out.indexOf("## Questions"));
		expect(out.indexOf("## Questions")).toBeLessThan(out.indexOf("## Units"));
		expect(parseChange(out).questions).toHaveLength(1);
	});

	it("multi-line text is refused", () => {
		expect(() => appendQuestion(body, "blocking", "a\nb")).toThrow(/single line/);
		expect(() => answerQuestion(body, "Q1", "blocking", "a\r\nb")).toThrow(/single line/);
	});

	it("unknown question is refused", () => {
		expect(() => answerQuestion(body, "Q9", "blocking", "x")).toThrow(/Q9/);
	});

	it("reclassify changes only the class", () => {
		const out = reclassifyQuestion(body, "Q1", "non-blocking");
		expect(changedLines(body, out)).toHaveLength(1);
		const q = parseChange(out).questions[0]!;
		expect(q).toMatchObject({ kind: "non-blocking", checked: false });
		const answered = reclassifyQuestion(body, "Q2", "blocking");
		expect(parseChange(answered).questions[1]).toMatchObject({ kind: "blocking", answer: "yes", checked: true });
		expect(reclassifyQuestion(crlf, "Q1", "non-blocking")).toContain("(non-blocking): Which header carries the client IP behind the proxy?\r\n");
	});

	it("raw spacing survives reclassify and answer", () => {
		const src = "## Questions\r\n- [ ] Q1 (blocking):   Keep spacing?  \r\n- [x] Q2 (blocking): T  — Answer:  a  b \r\n";
		expect(reclassifyQuestion(src, "Q1", "non-blocking")).toBe(
			"## Questions\r\n- [ ] Q1 (non-blocking):   Keep spacing?  \r\n- [x] Q2 (blocking): T  — Answer:  a  b \r\n",
		);
		expect(reclassifyQuestion(src, "Q2", "non-blocking")).toBe(
			"## Questions\r\n- [ ] Q1 (blocking):   Keep spacing?  \r\n- [x] Q2 (non-blocking): T  — Answer:  a  b \r\n",
		);
		expect(answerQuestion(src, "Q1", "blocking", "yes")).toBe(
			"## Questions\r\n- [x] Q1 (blocking):   Keep spacing? — Answer: yes\r\n- [x] Q2 (blocking): T  — Answer:  a  b \r\n",
		);
	});
});
