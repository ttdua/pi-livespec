import { rm } from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { checkCompat } from "../../src/content/compat.ts";
import { registerBuiltinRules } from "../../src/decide/registry.ts";
import { registerBuiltinChecks } from "../../src/engine/checks.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { registerPackSchema, resetRegistryForTests } from "../../src/engine/registry.ts";
import { PERSONA, defaultPack, skillFile, tempDir, validTreeFiles, writeTree } from "./helpers.ts";

let pack: Pack;
let tree: string;

beforeAll(async () => {
	pack = await defaultPack();
});
beforeEach(async () => {
	tree = await tempDir("compat");
	await writeTree(tree, validTreeFiles(pack));
});
afterEach(async () => {
	resetRegistryForTests();
	registerBuiltinRules();
	registerBuiltinChecks();
	await rm(tree, { recursive: true, force: true });
});

const items = (r: { failures: { item: string }[] }) => r.failures.map((f) => f.item);

describe("checkCompat", () => {
	test("compatible tree passes", async () => {
		expect(await checkCompat(tree, pack)).toEqual({ ok: true, failures: [] });
	});

	test("Malformed front matter", async () => {
		await writeTree(tree, { "skills/idea-refine/SKILL.md": "---\nname: idea-refine\ndescription: [unclosed\n---\nBody\n" });
		const r = await checkCompat(tree, pack);
		expect(r.ok).toBe(false);
		expect(items(r)).toEqual(["idea-refine"]);
	});

	test("Description too long", async () => {
		await writeTree(tree, { "skills/interview-me/SKILL.md": skillFile("interview-me", "x".repeat(1025)) });
		const r = await checkCompat(tree, pack);
		expect(r.ok).toBe(false);
		expect(items(r)).toEqual(["interview-me"]);
	});

	test("description of exactly 1024 characters passes", async () => {
		await writeTree(tree, { "skills/interview-me/SKILL.md": skillFile("interview-me", "x".repeat(1024)) });
		expect((await checkCompat(tree, pack)).ok).toBe(true);
	});

	test("Name mismatch", async () => {
		await writeTree(tree, { "skills/interview-me/SKILL.md": skillFile("interview") });
		const r = await checkCompat(tree, pack);
		expect(r.ok).toBe(false);
		expect(items(r)).toEqual(["interview-me"]);
	});

	test("missing SKILL.md and missing front matter name the skill", async () => {
		await writeTree(tree, { "skills/interview-me": null, "skills/idea-refine/SKILL.md": "no front matter\n" });
		expect(items(await checkCompat(tree, pack))).toEqual(["idea-refine", "interview-me"]);
	});

	test("Missing persona", async () => {
		registerPackSchema("decisions", { validate() {}, personas: () => [PERSONA] });
		await writeTree(tree, { [`agents/${PERSONA}.md`]: null });
		const r = await checkCompat(tree, pack);
		expect(r.ok).toBe(false);
		expect(items(r)).toEqual([PERSONA]);
	});

	test("present persona passes", async () => {
		registerPackSchema("decisions", { validate() {}, personas: () => [PERSONA] });
		expect((await checkCompat(tree, pack)).ok).toBe(true);
	});
});
