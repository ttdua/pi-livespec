import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { joinLines, splitLines } from "../../src/core/lines.ts";
import { replaceSection, sectionText, setHeaderLine } from "../../src/core/sections.ts";

const body = readFileSync(new URL("../fixtures/change-body.md", import.meta.url), "utf8");
const texts = (s: string) => splitLines(s).map((l) => l.text + l.eol);

describe("sections", () => {
	it("sectionText returns the Proposal body", () => {
		expect(sectionText(body, "Proposal")).toBe("Limit each client IP.");
		expect(sectionText(body, "Nope")).toBeUndefined();
	});

	it("replaceSection keeps every other line byte-identical", () => {
		const out = replaceSection(body, "Design", "New design.\n");
		expect(sectionText(out, "Design")).toBe("New design.");
		const before = texts(body);
		const after = texts(out);
		const kept = before.filter((l) => l !== "Sliding window counter in memory.\n");
		expect(after.filter((l) => kept.includes(l))).toEqual(kept);
		expect(joinLines(splitLines(out))).toBe(out);
	});

	it("replaceSection creates Design after Proposal", () => {
		const src = "Base: x\n\n## Proposal\nP.\n\n## Questions\nQ\n";
		const out = replaceSection(src, "Design", "D.");
		expect(out).toBe("Base: x\n\n## Proposal\nP.\n\n## Design\nD.\n\n## Questions\nQ\n");
	});

	it("replaceSection creates Proposal before Questions when both are missing", () => {
		const src = "Base: x\n\n## Questions\nQ\n";
		const out = replaceSection(src, "Proposal", "P.");
		expect(out).toBe("Base: x\n\n## Proposal\nP.\n\n## Questions\nQ\n");
		expect(replaceSection("Base: x\n", "Proposal", "P.")).toBe("Base: x\n\n## Proposal\nP.\n");
	});

	it("setHeaderLine replaces an existing ownership line", () => {
		const out = setHeaderLine(body, "PR", "#99");
		expect(out).toBe(body.replace("PR: #41", "PR: #99"));
	});

	it("setHeaderLine inserts a missing key before the first H2", () => {
		const src = "Base: x\n\n## Proposal\nP.\n";
		expect(setHeaderLine(src, "PR", "#1")).toBe("Base: x\nPR: #1\n\n## Proposal\nP.\n");
	});

	it("replaceSection keeps CRLF endings", () => {
		const src = "Base: x\r\n\r\n## Proposal\r\nP.\r\n\r\n## Questions\r\nQ\r\n";
		const out = replaceSection(src, "Design", "D1\nD2");
		expect(out).toBe("Base: x\r\n\r\n## Proposal\r\nP.\r\n\r\n## Design\r\nD1\r\nD2\r\n\r\n## Questions\r\nQ\r\n");
		expect(out.replace(/\r\n/g, "")).not.toContain("\n");
	});
});

describe("sections: fix round 1", () => {
	it("replaceSection terminates an unterminated heading before its content", () => {
		expect(replaceSection("## Proposal", "Proposal", "P.")).toBe("## Proposal\nP.\n");
		expect(replaceSection("## Proposal", "Proposal", "P.")).not.toContain("ProposalP.");
	});

	it("replaceSection terminates an unterminated heading with the body EOL", () => {
		expect(replaceSection("## Proposal", "Proposal", "P.")).toBe("## Proposal\nP.\n");
		expect(replaceSection("A\r\n## Proposal", "Proposal", "P.")).toBe("A\r\n## Proposal\r\nP.\r\n");
	});

	it("replaceSection keeps lines outside the written region identical as Line[]", () => {
		const src = "Base: x\r\n\r\n## Proposal\r\nP.\r\n\r\n## Questions\r\nQ\r\n## Units\nU";
		const out = replaceSection(src, "Proposal", "New.");
		const a = splitLines(src);
		const b = splitLines(out);
		// prefix up to and including heading, suffix from "## Questions" on
		expect(b.slice(0, 3)).toEqual(a.slice(0, 3));
		expect(b.slice(-4)).toEqual(a.slice(-4));
		expect(b.at(-1)).toEqual({ text: "U", eol: "" });
	});

	it("replaceSection appends after an unterminated final line, which only gains the body EOL", () => {
		const out = replaceSection("Base: x\r\n\r\n## Proposal\r\nP.", "Design", "D.");
		expect(splitLines(out)).toEqual([
			{ text: "Base: x", eol: "\r\n" },
			{ text: "", eol: "\r\n" },
			{ text: "## Proposal", eol: "\r\n" },
			{ text: "P.", eol: "\r\n" },
			{ text: "", eol: "\r\n" },
			{ text: "## Design", eol: "\r\n" },
			{ text: "D.", eol: "\r\n" },
		]);
	});

	it("setHeaderLine only terminates the unterminated final line when a new line must follow", () => {
		expect(setHeaderLine("Base: x", "PR", "#1")).toBe("Base: x\nPR: #1\n");
		expect(setHeaderLine("Base: x\r\nB: y\r\n\r\n## P\r\nz", "PR", "#1")).toBe(
			"Base: x\r\nB: y\r\nPR: #1\r\n\r\n## P\r\nz",
		);
		expect(setHeaderLine("Base: x\nPR: old", "PR", "#2")).toBe("Base: x\nPR: #2");
	});

	it("replaceSection keeps CRLF endings when replacing an existing section", () => {
		const src = "Base: x\r\n\r\n## Proposal\r\nP.\r\n\r\n## Questions\r\nQ\r\n";
		const out = replaceSection(src, "Proposal", "N1\nN2");
		expect(out).toBe("Base: x\r\n\r\n## Proposal\r\nN1\r\nN2\r\n\r\n## Questions\r\nQ\r\n");
	});
});
