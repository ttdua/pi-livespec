import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const evidence = readFileSync(new URL("docs/evidence/host-seams.md", root), "utf8");
const probeLetters = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
const subsections = ["Question", "Method", "Result", "Consequence", "Fallback"];

function probeSections(text: string): Map<string, string> {
	const sections = new Map<string, string>();
	const parts = text.split(/^## \(([a-z])\) /m);
	for (let i = 1; i < parts.length; i += 2) sections.set(parts[i]!, parts[i + 1]!);
	return sections;
}

function subsectionBody(section: string, name: string): string {
	const match = section.match(new RegExp(`^### ${name}\\n([\\s\\S]*?)(?=^### |^---|$(?![\\s\\S]))`, "m"));
	return match ? match[1]!.trim() : "";
}

describe("host seam evidence", () => {
	const sections = probeSections(evidence);

	it("has one section per probe a to j, in order", () => {
		expect([...sections.keys()]).toEqual(probeLetters);
	});

	it.each(probeLetters)("probe %s has Question, Method, Result, Consequence and Fallback", (letter) => {
		const section = sections.get(letter) ?? "";
		for (const name of subsections) {
			expect(subsectionBody(section, name), `${letter}: ${name}`).not.toBe("");
		}
	});

	it("names a fallback for every probe", () => {
		for (const letter of probeLetters) {
			expect(subsectionBody(sections.get(letter) ?? "", "Fallback"), letter).not.toBe("");
		}
	});

	it("marks an unverified probe with a reason and no other result text", () => {
		for (const [letter, section] of sections) {
			const result = subsectionBody(section, "Result");
			if (/^Unverified/i.test(result)) {
				expect(result, letter).toMatch(/^Unverified: \S.*$/);
				expect(result.split("\n").filter((l) => l.trim()).length, letter).toBe(1);
			}
		}
	});
});

describe("ADR index", () => {
	const dir = new URL("docs/decisions/", root);
	const readme = readFileSync(new URL("README.md", dir), "utf8");
	const adrFiles = readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f));

	it("lists every ADR file in the README table", () => {
		for (const file of adrFiles) expect(readme, file).toContain(`(${file})`);
	});

	it("links every Superseded status to an existing ADR", () => {
		for (const file of adrFiles) {
			const text = readFileSync(new URL(file, dir), "utf8");
			const status = text.match(/^Status: (.*)$/m)?.[1] ?? "";
			if (/Superseded/i.test(status)) {
				const link = status.match(/\]\(([^)]+\.md)\)/)?.[1];
				expect(link, `${file} needs a link`).toBeDefined();
				expect(existsSync(new URL(link!, dir)), `${file} -> ${link}`).toBe(true);
			}
		}
	});
});
