import { describe, expect, test } from "vitest";
import { parseChange } from "../../src/core/change.ts";
import { parseGlossary } from "../../src/core/glossary.ts";
import { addedGlossaryEntries, addedSpecLines, frontMatterEnd, glossaryCandidates, glossaryTermsCheck } from "../../src/docs/glossary-terms.ts";
import { GitError } from "../../src/engine/git.ts";
import { type CheckContext, type CheckGit } from "../../src/engine/registry.ts";

const EMPTY = parseGlossary("# Glossary\n");
const diffOf = (file: string, body: string[], start = 1) =>
	`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +${start},${body.length} @@\n${body.map((l) => `+${l}`).join("\n")}\n`;

describe("glossaryCandidates", () => {
	test("New bold term warns", () => {
		expect(glossaryCandidates(["Each **Token bucket** refills every second."], EMPTY, "")).toEqual(["Token bucket"]);
	});
	test("Known term", () => {
		expect(glossaryCandidates(["**Unit**"], parseGlossary("- **Units**: things\n"), "")).toEqual([]);
	});
	test("Scenario keywords ignored", () => {
		expect(glossaryCandidates(["- **WHEN** a request arrives", "- **THEN** it is rejected"], EMPTY, "")).toEqual([]);
	});
	test("New proper noun warns", () => {
		expect(glossaryCandidates(["Requests go through the Gateway first."], EMPTY, "Rate limit text")).toEqual(["Gateway"]);
	});
	test("Proper noun exclusions", () => {
		expect(glossaryCandidates(["Clients call `RateLimiter` and the API once."], EMPTY, "")).toEqual([]);
	});
	test("known at Base in another spec", () => {
		expect(glossaryCandidates(["Requests go through the Gateway first."], EMPTY, "The Gateway authenticates.")).toEqual([]);
	});
	test("punctuation after bold term", () => {
		expect(glossaryCandidates(["See **Token bucket**, then more."], EMPTY, "")).toEqual(["Token bucket"]);
	});
	test("bold term in a heading warns", () => {
		expect(glossaryCandidates(["### **Token bucket**"], EMPTY, "")).toEqual(["Token bucket"]);
	});
	test("sentence wrapped before a proper noun is not a sentence start", () => {
		expect(glossaryCandidates(["Requests go through the", "Gateway first."], EMPTY, "")).toEqual(["Gateway"]);
	});
	test("a list item continues on the indented next line", () => {
		expect(glossaryCandidates(["- Requests go through the", "  Gateway first."], EMPTY, "")).toEqual(["Gateway"]);
	});
	test("a line ending with a period starts a new sentence", () => {
		expect(glossaryCandidates(["Requests go through the gateway.", "Gateway first."], EMPTY, "")).toEqual([]);
	});
	test("a blank line starts a new sentence", () => {
		expect(glossaryCandidates(["Requests go through the", "", "Gateway first."], EMPTY, "")).toEqual([]);
	});
});

describe("frontMatterEnd", () => {
	test("last line of the leading front matter", () => {
		expect(frontMatterEnd("---\ncapability: x\n---\n\nBody")).toBe(3);
	});
	test("no front matter", () => {
		expect(frontMatterEnd("# Title\n")).toBe(0);
	});
});

describe("addedSpecLines", () => {
	test("skips front matter and non-spec files", () => {
		const diff = [
			diffOf("specs/rate-limit/spec.md", ["---", "paths: [src/**]", "---", "", "Each **Token bucket** refills."]),
			diffOf("specs/glossary.md", ["- **Other**: x"]),
			diffOf("src/a.ts", ["Hello **There**"]),
		].join("");
		const ends = new Map([["specs/rate-limit/spec.md", 3]]);
		expect(addedSpecLines(diff, ends)).toEqual([
			{ file: "specs/rate-limit/spec.md", line: "", no: 4 },
			{ file: "specs/rate-limit/spec.md", line: "Each **Token bucket** refills.", no: 5 },
		]);
	});
	test("a hunk starting inside a long front matter is skipped", () => {
		const diff = diffOf("specs/rate/spec.md", ["description: Uses **Token bucket**"], 5);
		expect(addedSpecLines(diff, new Map([["specs/rate/spec.md", 8]]))).toEqual([]);
	});
});

describe("addedGlossaryEntries", () => {
	test("lists added entries", () => {
		const diff = diffOf("specs/glossary.md", ["- **Token bucket**: a refilling request budget", "text"]);
		expect(addedGlossaryEntries(diff)).toEqual(["- **Token bucket**: a refilling request budget"]);
	});
});

function stubGit(overrides: Partial<CheckGit>): CheckGit {
	return {
		diff: async () => "",
		head: async () => "HEAD",
		showFile: async () => undefined,
		listTree: async () => [],
		...overrides,
	};
}

const checkCtx = (git: CheckGit): CheckContext =>
	({ root: "/nowhere", change: parseChange("Base: abc123\nCapabilities: new [rate], modified []\n"), git, marked: [] });

describe("glossaryTermsCheck", () => {
	test("sentences do not join across hunks or unadded lines", async () => {
		const diff = [
			"diff --git a/specs/rate/spec.md b/specs/rate/spec.md",
			"--- a/specs/rate/spec.md",
			"+++ b/specs/rate/spec.md",
			"@@ -4,0 +5,1 @@",
			"+Requests use the cache",
			"@@ -18,0 +20,2 @@",
			"+Clients connect.",
			"+Other text",
			"",
		].join("\n");
		const git = stubGit({ diff: async () => diff });
		expect(await glossaryTermsCheck(checkCtx(git))).toEqual([]);
	});

	test("hunk inside front matter at HEAD is not spec text", async () => {
		const head = ["---", "capability: rate", "paths: [src/**]", "description: a", "more: b", "tags: c", "owner: d", "---", "", "Body"].join("\n");
		const git = stubGit({
			diff: async () => diffOf("specs/rate/spec.md", ["description: Uses **Token bucket**"], 5),
			showFile: async () => head,
		});
		expect(await glossaryTermsCheck(checkCtx(git))).toEqual([]);
	});

	test("git failure is one warning naming the operation", async () => {
		const failure = new GitError(["diff", "abc123", "HEAD", "--", "specs/"], 128, "fatal: bad revision");
		const git = stubGit({
			diff: async () => {
				throw failure;
			},
		});
		const out = await glossaryTermsCheck(checkCtx(git));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ code: "glossary-terms", severity: "warning" });
		expect(out[0]?.message).toContain("git diff abc123 HEAD -- specs/ failed");
	});
});
