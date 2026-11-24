import { describe, expect, test } from "vitest";
import { parseGlossary } from "../../src/core/glossary.ts";
import { addedGlossaryEntries, addedSpecLines, glossaryCandidates } from "../../src/docs/glossary-terms.ts";

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
});

describe("addedSpecLines", () => {
	test("skips front matter and non-spec files", () => {
		const diff = [
			diffOf("specs/rate-limit/spec.md", ["---", "paths: [src/**]", "---", "", "Each **Token bucket** refills."]),
			diffOf("specs/glossary.md", ["- **Other**: x"]),
			diffOf("src/a.ts", ["Hello **There**"]),
		].join("");
		expect(addedSpecLines(diff)).toEqual([
			{ file: "specs/rate-limit/spec.md", line: "" },
			{ file: "specs/rate-limit/spec.md", line: "Each **Token bucket** refills." },
		]);
	});
});

describe("addedGlossaryEntries", () => {
	test("lists added entries", () => {
		const diff = diffOf("specs/glossary.md", ["- **Token bucket**: a refilling request budget", "text"]);
		expect(addedGlossaryEntries(diff)).toEqual(["- **Token bucket**: a refilling request budget"]);
	});
});
