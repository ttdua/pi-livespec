import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { MigrateError, runMigrate } from "../../src/commands/migrate.ts";
import { runValidate } from "../../src/commands/validate.ts";
import { commitAll, gitStatus, makeRepo, writeIn } from "../helpers/repo.ts";

const realExec = promisify(execFile);

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

	describe("hardening", () => {
		/** lstat-based snapshot: never follows symlinks, safe for dangling links. */
		function lsnap(root: string, dir = ""): string[] {
			const out: string[] = [];
			for (const name of readdirSync(join(root, dir)).sort()) {
				if (name === ".git") continue;
				const rel = join(dir, name);
				const st = lstatSync(join(root, rel));
				if (st.isSymbolicLink()) out.push(`${rel}->${readlinkSync(join(root, rel))}`);
				else if (st.isDirectory()) out.push(`${rel}/`, ...lsnap(root, rel));
				else out.push(`${rel}:${readFileSync(join(root, rel), "utf8")}`);
			}
			return out;
		}
		const index = (root: string) => execFileSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" });

		it("symlinked spec.md (file or dangling) is not moved", async () => {
			const root = await makeRepo();
			await writeIn(root, "real.md", SPEC("r"));
			await writeIn(root, "openspec/specs/b/spec.md", SPEC("b"));
			mkdirSync(join(root, "openspec/specs/a"), { recursive: true });
			symlinkSync("../../../real.md", join(root, "openspec/specs/a/spec.md"));
			mkdirSync(join(root, "openspec/specs/c"), { recursive: true });
			symlinkSync("nowhere", join(root, "openspec/specs/c/spec.md"));
			commitAll(root);
			const res = await runMigrate(root);
			expect(res.moved).toEqual(["specs/b/spec.md"]);
			expect(lstatSync(join(root, "openspec/specs/a/spec.md")).isSymbolicLink()).toBe(true);
			expect(lstatSync(join(root, "openspec/specs/c/spec.md")).isSymbolicLink()).toBe(true);
			expect(existsSync(join(root, "specs/a"))).toBe(false);
			expect(existsSync(join(root, "specs/c"))).toBe(false);
		});

		it("dangling target symlink refuses and touches nothing", async () => {
			const root = await makeRepo();
			await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
			await writeIn(root, "openspec/specs/b/spec.md", SPEC("b"));
			mkdirSync(join(root, "specs/b"), { recursive: true });
			symlinkSync("nowhere", join(root, "specs/b/spec.md"));
			commitAll(root);
			const before = lsnap(root);
			const idx = index(root);
			const res = await runMigrate(root);
			expect(res.moved).toEqual([]);
			expect(res.conflicts.join("\n")).toContain("specs/b/spec.md");
			expect(lsnap(root)).toEqual(before);
			expect(index(root)).toBe(idx);
		});

		it("symlinked target parent refuses and touches nothing", async () => {
			const root = await makeRepo();
			await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
			await writeIn(root, "openspec/specs/b/spec.md", SPEC("b"));
			await writeIn(root, "specs/a/keep.md", "k");
			symlinkSync("a", join(root, "specs/b"));
			commitAll(root);
			const before = lsnap(root);
			const idx = index(root);
			const res = await runMigrate(root);
			expect(res.moved).toEqual([]);
			expect(res.conflicts.join("\n")).toContain("specs/b");
			expect(lsnap(root)).toEqual(before);
			expect(index(root)).toBe(idx);
		});

		it("specs that is not a directory refuses", async () => {
			const root = await makeRepo();
			await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
			await writeIn(root, "specs", "file");
			commitAll(root);
			const before = lsnap(root);
			const res = await runMigrate(root);
			expect(res.moved).toEqual([]);
			expect(res.conflicts.length).toBeGreaterThan(0);
			expect(lsnap(root)).toEqual(before);
		});

		it("untracked source refuses and touches nothing", async () => {
			const root = await makeRepo();
			await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
			commitAll(root);
			await writeIn(root, "openspec/specs/b/spec.md", SPEC("b"));
			const before = lsnap(root);
			const idx = index(root);
			const res = await runMigrate(root);
			expect(res.moved).toEqual([]);
			expect(res.conflicts.join("\n")).toMatch(/openspec\/specs\/b\/spec\.md.*not tracked/);
			expect(lsnap(root)).toEqual(before);
			expect(index(root)).toBe(idx);
		});

		it("case-colliding targets refuse", async () => {
			const root = await makeRepo();
			await writeIn(root, "openspec/specs/A/spec.md", SPEC("A"));
			await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
			if (readdirSync(join(root, "openspec/specs")).length < 2) return; // case-insensitive FS
			commitAll(root);
			const before = lsnap(root);
			const res = await runMigrate(root);
			expect(res.moved).toEqual([]);
			expect(res.conflicts.length).toBeGreaterThan(0);
			expect(lsnap(root)).toEqual(before);
		});

		it("partial git mv failure throws MigrateError with moved, failed and hint", async () => {
			const root = await makeRepo();
			await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
			await writeIn(root, "openspec/specs/b/spec.md", SPEC("b"));
			commitAll(root);
			let mvCalls = 0;
			const exec = async (file: string, args: string[], opts: { cwd: string }) => {
				if (args[0] === "mv" && ++mvCalls === 2) throw new Error("boom");
				return realExec(file, args, opts);
			};
			const err = (await runMigrate(root, { exec }).catch((e: unknown) => e)) as MigrateError;
			expect(err).toBeInstanceOf(MigrateError);
			expect(err.moved).toEqual(["specs/a/spec.md"]);
			expect(err.failed).toBe("specs/b/spec.md");
			expect(err.hint).toContain("git restore --staged --worktree");
			expect(err.message).toContain("boom");
			expect(existsSync(join(root, "specs/a/spec.md"))).toBe(true);
			expect(existsSync(join(root, "openspec/specs/b/spec.md"))).toBe(true);
		});

		it("non-ENOENT errors propagate with the path", async () => {
			if (process.getuid?.() === 0) return;
			const root = await makeRepo();
			await writeIn(root, "openspec/specs/a/spec.md", SPEC("a"));
			commitAll(root);
			const dir = join(root, "openspec/specs");
			chmodSync(dir, 0o000);
			try {
				try {
					readdirSync(dir);
					return; // chmod ineffective
				} catch {}
				await expect(runMigrate(root)).rejects.toThrow(/openspec\/specs/);
			} finally {
				chmodSync(dir, 0o755);
			}
		});
	});
});
