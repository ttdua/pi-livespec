import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../../src/core/frontmatter.ts";
import { joinLines, splitLines } from "../../src/core/lines.ts";

describe("lines", () => {
	const samples: Record<string, string> = {
		LF: "a\nb\nc\n",
		CRLF: "a\r\nb\r\nc\r\n",
		mixed: "a\r\nb\nc\r\n",
		empty: "",
		"no trailing newline": "a\nb",
		"blank lines": "\n\n",
	};
	for (const [name, s] of Object.entries(samples)) {
		it(`round trips ${name}`, () => {
			expect(joinLines(splitLines(s))).toBe(s);
		});
	}

	it("records eol per line", () => {
		expect(splitLines("a\r\nb")).toEqual([
			{ text: "a", eol: "\r\n" },
			{ text: "b", eol: "" },
		]);
		expect(splitLines("")).toEqual([]);
	});
});

describe("frontmatter", () => {
	it("parses leading block", () => {
		const fm = parseFrontmatter('---\r\npaths: ["src/**"]\r\n---\r\nbody\r\n');
		expect(fm.data).toEqual({ paths: ["src/**"] });
		expect(fm.raw).toHaveLength(3);
		expect(joinLines(fm.body)).toBe("body\r\n");
		expect(joinLines([...fm.raw, ...fm.body])).toBe('---\r\npaths: ["src/**"]\r\n---\r\nbody\r\n');
	});

	it("absent front matter leaves raw empty", () => {
		const fm = parseFrontmatter("# T\n");
		expect(fm.data).toEqual({});
		expect(fm.raw).toEqual([]);
		expect(joinLines(fm.body)).toBe("# T\n");
	});

	it("unterminated block is treated as absent", () => {
		const fm = parseFrontmatter("---\na: 1\n");
		expect(fm.raw).toEqual([]);
	});
});
