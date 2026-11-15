import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { diffSkills } from "../../src/content/skill-diff.ts";
import { skillFile, tempDir, writeTree } from "./helpers.ts";

let dir: string;
let before: string;
let after: string;
beforeEach(async () => {
	dir = await tempDir("diff");
	before = join(dir, "before");
	after = join(dir, "after");
	await writeTree(before, { "skills/kept/SKILL.md": skillFile("kept"), "skills/edited/SKILL.md": skillFile("edited"), "skills/gone/SKILL.md": skillFile("gone") });
	await writeTree(after, { "skills/kept/SKILL.md": skillFile("kept"), "skills/edited/SKILL.md": skillFile("edited", "New."), "skills/fresh/SKILL.md": skillFile("fresh") });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("diffSkills", () => {
	test("lists added, removed and changed skills separately", async () => {
		expect(await diffSkills(before, after, ["kept", "edited", "gone", "fresh"])).toEqual({ added: ["fresh"], removed: ["gone"], changed: ["edited"] });
	});

	test("a skill added upstream is listed as added only", async () => {
		expect(await diffSkills(before, after, ["fresh"])).toEqual({ added: ["fresh"], removed: [], changed: [] });
	});

	test("a skill removed upstream is listed as removed only", async () => {
		expect(await diffSkills(before, after, ["gone"])).toEqual({ added: [], removed: ["gone"], changed: [] });
	});

	test("ignores skills not named and skills absent from both trees", async () => {
		expect(await diffSkills(before, after, ["kept", "nowhere"])).toEqual({ added: [], removed: [], changed: [] });
	});

	test("every named skill is added on a first install", async () => {
		expect(await diffSkills(undefined, after, ["fresh", "kept"])).toEqual({ added: ["fresh", "kept"], removed: [], changed: [] });
	});
});
