import { describe, expect, it } from "vitest";
import { matchGlob, validateGlob } from "../../src/core/glob.ts";

describe("glob", () => {
	it("double star spans directories", () => {
		expect(matchGlob("src/limits/**", "src/limits/a/b.ts")).toBe(true);
		expect(matchGlob("**/*.ts", "a/b/c.ts")).toBe(true);
		expect(matchGlob("**/*.ts", "c.ts")).toBe(true);
	});

	it("single star stays in one segment", () => {
		expect(matchGlob("src/*.ts", "src/a/b.ts")).toBe(false);
		expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true);
	});

	it("question mark matches one non-slash char", () => {
		expect(matchGlob("a?.ts", "ab.ts")).toBe(true);
		expect(matchGlob("a?.ts", "a/.ts")).toBe(false);
		expect(matchGlob("a?.ts", "abc.ts")).toBe(false);
	});

	it("braces alternate", () => {
		expect(matchGlob("src/*.{ts,js}", "src/a.js")).toBe(true);
		expect(matchGlob("src/*.{ts,js}", "src/a.md")).toBe(false);
	});

	it("character classes", () => {
		expect(matchGlob("f[ab].ts", "fa.ts")).toBe(true);
		expect(matchGlob("f[ab].ts", "fc.ts")).toBe(false);
		expect(matchGlob("f[!ab].ts", "fc.ts")).toBe(true);
	});

	it("escapes regex metacharacters", () => {
		expect(matchGlob("a.b", "axb")).toBe(false);
		expect(matchGlob("a(b)+", "a(b)+")).toBe(true);
	});

	it("negated character class does not match separator", () => {
		expect(matchGlob("src/[!a]*.ts", "src//nested.ts")).toBe(false);
		expect(matchGlob("src/[!a]*.ts", "src/b.ts")).toBe(true);
		expect(matchGlob("src/[^a]*.ts", "src//nested.ts")).toBe(false);
	});

	it("positive character class does not match separator", () => {
		expect(matchGlob("src/[/]x.ts", "src//x.ts")).toBe(false);
	});

	it("out-of-order range is reported as invalid and never throws", () => {
		expect(validateGlob("src/[z-a].ts")).toMatch(/range/i);
		expect(() => matchGlob("src/[z-a].ts", "src/z.ts")).not.toThrow();
		expect(matchGlob("src/[z-a].ts", "src/z.ts")).toBe(false);
	});

	it("invalid glob detected", () => {
		expect(validateGlob("src/{a,b")).toMatch(/\{/);
		expect(validateGlob("src/[ab")).toMatch(/\[/);
		expect(validateGlob("src/}")).not.toBeNull();
		expect(validateGlob("src/{a,b}/[ab]/**")).toBeNull();
	});
});
