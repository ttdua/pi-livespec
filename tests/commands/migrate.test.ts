import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrate } from "../../src/commands/migrate.ts";
import { runValidate } from "../../src/commands/validate.ts";
import { commitAll, gitStatus, makeRepo, writeIn } from "../helpers/repo.ts";

const SPEC = (n: string) =>
	`# ${n}\r\n\r\n## Purpose\r\nx\r\n\r\n## Requirements\r\n\r\n### Requirement: R\r\nThe system SHALL x.\r\n\r\n#### Scenario: S\r\n- **WHEN** w\r\n- **THEN** t\r\n`;

function tree(root: string, dir = ""): string[] {
	const out: string[] = [];
	for (const name of readdirSync(join(root, dir)).sort()) {
		if (name === ".git") continue;
		const rel = join(dir, name);
		if (statSync(join(root, rel)).isDirectory()) out.push(`${rel}/`, ...tree(root, rel));
		else out.push(`${rel}:${readFileSync(join(root, rel), "utf8")}`);
	}
	return out;
}

describe("migrate", () => {
	it("specs moved", async () => {
		const root = await makeRepo();
		await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
		await writeIn(root, "openspec/specs/b/spec.md", SPEC("b"));
		commitAll(root);
		const res = await runMigrate(root);
		expect(res.conflicts).toEqual([]);
		expect(res.moved).toEqual(["specs/a/spec.md", "specs/b/spec.md"]);
		expect(readFileSync(join(root, "specs/a/spec.md"))).toEqual(Buffer.from(SPEC("a")));
		expect(readFileSync(join(root, "specs/b/spec.md"))).toEqual(Buffer.from(SPEC("b")));
		expect(existsSync(join(root, "openspec/specs/a/spec.md"))).toBe(false);
		expect(gitStatus(root)).toEqual([
			"R  openspec/specs/a/spec.md -> specs/a/spec.md",
			"R  openspec/specs/b/spec.md -> specs/b/spec.md",
		]);
	});

	it("only spec files are moved", async () => {
		const root = await makeRepo();
		await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
		await writeIn(root, "openspec/specs/a/notes.md", "notes");
		await writeIn(root, "openspec/specs/README.md", "readme");
		await writeIn(root, "openspec/specs/.gitkeep", "");
		await writeIn(root, "openspec/config.yaml", "schema: x\n");
		await writeIn(root, "openspec/schemas/s/schema.yaml", "s");
		await writeIn(root, "openspec/changes/x/proposal.md", "p");
		commitAll(root);
		const res = await runMigrate(root);
		expect(res.moved).toEqual(["specs/a/spec.md"]);
		expect(tree(root).filter((e) => !e.startsWith("specs/") && !e.startsWith("openspec/specs/a/spec"))).toEqual(
			[
				"openspec/",
				"openspec/changes/",
				"openspec/changes/x/",
				"openspec/changes/x/proposal.md:p",
				"openspec/config.yaml:schema: x\n",
				"openspec/schemas/",
				"openspec/schemas/s/",
				"openspec/schemas/s/schema.yaml:s",
				"openspec/specs/",
				"openspec/specs/.gitkeep:",
				"openspec/specs/README.md:readme",
				"openspec/specs/a/",
				"openspec/specs/a/notes.md:notes",
			],
		);
		expect(readdirSync(join(root, "specs"))).toEqual(["a"]);
		expect(readdirSync(join(root, "specs/a"))).toEqual(["spec.md"]);
	});

	it("directories without spec files", async () => {
		const root = await makeRepo();
		await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
		await writeIn(root, "openspec/specs/empty/other.md", "o");
		commitAll(root);
		const res = await runMigrate(root);
		expect(res.moved).toEqual(["specs/a/spec.md"]);
		expect(existsSync(join(root, "specs/empty"))).toBe(false);
		expect(readFileSync(join(root, "openspec/specs/empty/other.md"), "utf8")).toBe("o");
	});

	it("target exists", async () => {
		const root = await makeRepo();
		await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
		await writeIn(root, "openspec/specs/b/spec.md", SPEC("b"));
		await writeIn(root, "specs/a/spec.md", "existing");
		commitAll(root);
		const before = tree(root);
		const res = await runMigrate(root);
		expect(res.conflicts).toEqual(["specs/a/spec.md"]);
		expect(res.moved).toEqual([]);
		expect(tree(root)).toEqual(before);
		expect(gitStatus(root)).toEqual([]);
	});

	it("nothing to migrate", async () => {
		const root = await makeRepo();
		await writeIn(root, "openspec/specs/README.md", "r");
		commitAll(root);
		const before = tree(root);
		expect(await runMigrate(root)).toEqual({ moved: [], conflicts: [] });
		expect(tree(root)).toEqual(before);
		const bare = await makeRepo();
		expect(await runMigrate(bare)).toEqual({ moved: [], conflicts: [] });
		expect(tree(bare)).toEqual([]);
	});

	it("migrate then validate", async () => {
		const root = await makeRepo();
		await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
		commitAll(root);
		await runMigrate(root);
		const results = await runValidate(root);
		expect(results.filter((r) => r.severity === "error")).toEqual([]);
	});
});
