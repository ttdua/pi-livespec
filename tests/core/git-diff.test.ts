import { describe, expect, it } from "vitest";
import { parseGitDiff } from "../../src/core/git-diff.ts";

const file = (oldPath: string, newPath = oldPath, extra: Partial<ReturnType<typeof parseGitDiff>[number]> = {}) => ({
	oldPath,
	newPath,
	newFile: false,
	deletedFile: false,
	renamed: false,
	...extra,
});

describe("git-diff.test", () => {
	it("splits every file at a diff header and resets state per file", () => {
		const diff = [
			"diff --git a/specs/decisions/0001-x.md b/specs/decisions/0001-x.md",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/specs/decisions/0001-x.md",
			"@@ -0,0 +1 @@",
			"+# x",
			"diff --git a/specs/cache/spec.md b/specs/cache/spec.md",
			"--- a/specs/cache/spec.md",
			"+++ b/specs/cache/spec.md",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n");
		expect(parseGitDiff(diff)).toEqual([
			file("specs/decisions/0001-x.md", "specs/decisions/0001-x.md", { newFile: true }),
			file("specs/cache/spec.md"),
		]);
	});

	it("hunk content that looks like a header is not parsed as metadata", () => {
		const diff = [
			"diff --git a/specs/cache/a.md b/specs/cache/a.md",
			"--- a/specs/cache/a.md",
			"+++ b/specs/cache/a.md",
			"@@ -1,2 +1,2 @@",
			"--- a/specs/other/x.md",
			"+new file mode 100644",
			"deleted file mode 100644",
		].join("\n");
		expect(parseGitDiff(diff)).toEqual([file("specs/cache/a.md")]);
	});

	it("reads unquoted paths with spaces from the ---/+++ lines", () => {
		const diff = [
			"diff --git a/specs/rate-limit/my spec.md b/specs/rate-limit/my spec.md",
			"--- a/specs/rate-limit/my spec.md\t",
			"+++ b/specs/rate-limit/my spec.md\t",
			"@@ -1 +1 @@",
		].join("\n");
		expect(parseGitDiff(diff)).toEqual([file("specs/rate-limit/my spec.md")]);
	});

	it("prefers rename lines over the ambiguous header split", () => {
		const diff = [
			"diff --git a/specs/a b/c.md b/specs/x/d e.md",
			"similarity index 90%",
			"rename from specs/a b/c.md",
			"rename to specs/x/d e.md",
		].join("\n");
		expect(parseGitDiff(diff)).toEqual([
			file("specs/a b/c.md", "specs/x/d e.md", { renamed: true }),
		]);
	});

	it("decodes git C-quoted paths: octal UTF-8 bytes, escaped quote, backslash, tab", () => {
		const diff = [
			String.raw`diff --git "a/specs/rate-limit/caf\303\251 \"q\".md" "b/specs/rate-limit/caf\303\251 \"q\".md"`,
			String.raw`--- "a/specs/rate-limit/caf\303\251 \"q\".md"`,
			String.raw`+++ "b/specs/rate-limit/caf\303\251 \"q\".md"`,
			String.raw`diff --git "a/specs/x\\y\tz.md" "b/specs/x\\y\tz.md"`,
		].join("\n");
		expect(parseGitDiff(diff)).toEqual([
			file('specs/rate-limit/café "q".md'),
			file("specs/x\\y\tz.md"),
		]);
	});

	it("keeps raw non-ASCII characters inside a quoted path intact", () => {
		const name = '\\"🚀\\".md';
		const diff = `diff --git "a/specs/rate-limit/${name}" "b/specs/rate-limit/${name}"`;
		expect(parseGitDiff(diff)).toEqual([file('specs/rate-limit/"🚀".md')]);
	});

	it("decodes quoted rename paths", () => {
		const diff = [
			String.raw`diff --git "a/specs/old\303\251.md" "b/specs/new \"x\".md"`,
			String.raw`rename from "specs/old\303\251.md"`,
			String.raw`rename to "specs/new \"x\".md"`,
		].join("\n");
		expect(parseGitDiff(diff)).toEqual([
			file("specs/oldé.md", 'specs/new "x".md', { renamed: true }),
		]);
	});

	it("flags new and deleted files, and renames", () => {
		const diff = [
			"diff --git a/specs/cache/a.md b/specs/cache/a.md",
			"deleted file mode 100644",
			"diff --git a/specs/cache/b.md b/specs/cache/b.md",
			"new file mode 100644",
			"diff --git a/specs/old/c.md b/specs/new/c.md",
			"similarity index 100%",
			"rename from specs/old/c.md",
			"rename to specs/new/c.md",
		].join("\n");
		expect(parseGitDiff(diff)).toEqual([
			file("specs/cache/a.md", "specs/cache/a.md", { deletedFile: true }),
			file("specs/cache/b.md", "specs/cache/b.md", { newFile: true }),
			file("specs/old/c.md", "specs/new/c.md", { renamed: true }),
		]);
	});

	it("returns no files for empty input", () => {
		expect(parseGitDiff("")).toEqual([]);
	});
});
