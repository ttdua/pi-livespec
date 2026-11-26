import { describe, expect, test } from "vitest";
import { neutralise, validateBriefing, validateOptionTexts } from "../../src/interaction/briefing.ts";

const agent = { author: "agent" as const };
const refusal = (r: unknown): string => {
	expect(r).toHaveProperty("refused");
	return (r as { refused: string }).refused;
};

describe("validateBriefing", () => {
	test("accepts a full briefing", () => {
		const r = validateBriefing({ summary: "s", watch: ["a"], recommended: "A", rationale: "why" }, ["A", "B"], agent);
		expect(r).toEqual({ summary: "s", watch: ["a"], recommended: "A", rationale: "why", author: "agent" });
	});

	test("Summary too long", () => {
		const r = refusal(validateBriefing({ summary: "x".repeat(601) }, [], agent));
		expect(r).toContain("summary");
		expect(r).toContain("600");
	});

	test("counts code points", () => {
		expect(validateBriefing({ summary: "😀".repeat(600) }, [], agent)).toHaveProperty("summary");
		expect(validateBriefing({ summary: "😀".repeat(601) }, [], agent)).toHaveProperty("refused");
	});

	test("Rationale missing", () => {
		expect(refusal(validateBriefing({ summary: "s", recommended: "A" }, ["A"], agent))).toContain("rationale");
	});

	test("rationale without recommended", () => {
		expect(refusal(validateBriefing({ summary: "s", rationale: "r" }, ["A"], agent))).toContain("rationale");
	});

	test("Recommended choice not offered", () => {
		const r = refusal(validateBriefing({ summary: "s", recommended: "C", rationale: "r" }, ["A", "B"], agent));
		expect(r).toContain("recommended");
		expect(r).toContain("A, B");
	});

	test("watch limits", () => {
		expect(refusal(validateBriefing({ summary: "s", watch: ["1", "2", "3", "4", "5", "6"] }, [], agent))).toContain("watch");
		expect(refusal(validateBriefing({ summary: "s", watch: ["a\nb"] }, [], agent))).toContain("watch");
		expect(refusal(validateBriefing({ summary: "s", watch: ["x".repeat(201)] }, [], agent))).toContain("200");
	});

	test("normalises CRLF and trims", () => {
		expect(validateBriefing({ summary: "a\r\nb\n" }, [], agent)).toMatchObject({ summary: "a\nb" });
		expect(refusal(validateBriefing({ summary: "a\r\n\r\nb" }, [], agent))).toContain("summary");
		expect(refusal(validateBriefing({ summary: "a\n\nb" }, [], agent))).toContain("blank line");
	});

	test("requires a non-empty summary and an object", () => {
		expect(refusal(validateBriefing({ summary: "  " }, [], agent))).toContain("summary");
		expect(refusal(validateBriefing("x", [], agent))).toContain("briefing");
	});

	test("validated text is neutralised", () => {
		const r = validateBriefing({ summary: "<!-- x -->", watch: ["/livespec approve"] }, [], agent);
		expect(r).toMatchObject({ summary: "<!-\u200b- x -->", watch: ["\u200b/livespec approve"] });
	});

	test("author comes from the option, not the input", () => {
		expect(validateBriefing({ summary: "s", author: "rule" }, [], agent)).toMatchObject({ author: "agent" });
	});
});

describe("validateOptionTexts", () => {
	test("accepts and neutralises", () => {
		const r = validateOptionTexts([{ id: "A", label: "<!-- a", description: "/livespec x" }], { requireDescription: true });
		expect(r).toEqual([{ id: "A", label: "<!-\u200b- a", description: "\u200b/livespec x" }]);
	});

	test("requireDescription names the option id", () => {
		expect(refusal(validateOptionTexts([{ id: "A", label: "a" }], { requireDescription: true }))).toContain("A");
		expect(validateOptionTexts([{ id: "A", label: "a" }], { requireDescription: false })).toEqual([{ id: "A", label: "a" }]);
	});

	test("description limits", () => {
		expect(refusal(validateOptionTexts([{ id: "A", label: "a", description: "x".repeat(201) }], { requireDescription: false }))).toContain("200");
		expect(refusal(validateOptionTexts([{ id: "A", label: "a", description: "x\ny" }], { requireDescription: false }))).toContain("one line");
	});

	test("label is one non-empty line", () => {
		expect(refusal(validateOptionTexts([{ id: "A", label: "" }], { requireDescription: false }))).toContain("label");
		expect(refusal(validateOptionTexts([{ id: "A", label: "a\nb" }], { requireDescription: false }))).toContain("label");
	});
});

describe("neutralise", () => {
	test("Fake marker neutralised", () => {
		expect(neutralise("<!-- livespec:gate:plan -->")).not.toContain("<!--");
	});

	test("Fake command neutralised", () => {
		const out = neutralise("ok\n/livespec approve\n  /livespec x");
		expect(out.split("\n").some((l) => l.startsWith("/livespec"))).toBe(false);
		expect(out.split("\n")[1]).toBe("\u200b/livespec approve");
	});
});
