import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createGit, type Git } from "../../src/engine/git.ts";
import type { RunOptions } from "../../src/evidence/runner.ts";
import { runVerify } from "../../src/evidence/runner.ts";
import { withTempWorktree } from "../../src/evidence/worktree.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";

const RUN: Omit<RunOptions, "cwd"> = { timeoutS: 30, guard: () => undefined, tokens: [], tailBytes: 8192 };

async function repoWithDeps(): Promise<{ root: string; git: Git; sha: string }> {
	const root = await makeRepo();
	await writeIn(root, ".gitignore", "node_modules/\n");
	await writeIn(root, "README.md", "x\n");
	commitAll(root);
	await mkdir(join(root, "node_modules", "dep"), { recursive: true });
	const git = createGit(root);
	return { root, git, sha: await git.head() };
}

function worktreeLines(root: string): string[] {
	return execFileSync("git", ["worktree", "list"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}

const verifyDirs = (): Set<string> => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("livespec-verify-")));

/** Asserts the repo has only its main worktree and no new `livespec-verify-*` directory exists. */
function expectCleaned(root: string, before: Set<string>): void {
	expect(worktreeLines(root)).toHaveLength(1);
	expect([...verifyDirs()].filter((n) => !before.has(n))).toEqual([]);
}

describe("withTempWorktree", () => {
	test("Dependencies linked", async () => {
		const { root, git, sha } = await repoWithDeps();
		let seen = "";
		const result = await withTempWorktree(git, root, sha, { run: RUN }, async (dir) => {
			seen = dir;
			const link = join(dir, "node_modules");
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readlinkSync(link)).toBe(join(root, "node_modules"));
			expect(existsSync(join(dir, "README.md"))).toBe(true);
			return "ran";
		});
		expect(result).toBe("ran");
		expect(seen.split("/").pop()).toMatch(/^livespec-verify-/);
		expect(existsSync(seen)).toBe(false);
		expect(existsSync(join(root, "node_modules", "dep"))).toBe(true);
		expect(worktreeLines(root)).toHaveLength(1);
	});

	test("a folder that is not ignored is not linked", async () => {
		const root = await makeRepo();
		await writeIn(root, "README.md", "x\n");
		commitAll(root);
		await mkdir(join(root, "vendor"), { recursive: true });
		const git = createGit(root);
		await withTempWorktree(git, root, await git.head(), { run: RUN }, async (dir) => {
			expect(existsSync(join(dir, "vendor"))).toBe(false);
		});
	});

	test("setup runs instead of linking", async () => {
		const { root, git, sha } = await repoWithDeps();
		await withTempWorktree(git, root, sha, { setup: "touch setup-ran", run: RUN }, async (dir) => {
			expect(existsSync(join(dir, "setup-ran"))).toBe(true);
			expect(existsSync(join(dir, "node_modules"))).toBe(false);
		});
	});

	test("setup that times out but exits 0 is invalid", async () => {
		const { root, git, sha } = await repoWithDeps();
		const before = verifyDirs();
		let ran = false;
		const setup = `trap "exit 0" TERM; while :; do :; done`;
		const r = await withTempWorktree(git, root, sha, { setup, run: { ...RUN, timeoutS: 1 } }, async () => {
			ran = true;
			return "ran";
		});
		expect(r).toMatchObject({ invalid: "setup" });
		expect(ran).toBe(false);
		expectCleaned(root, before);
	}, 15_000);

	test("temporary worktree is removed after error, timeout and failed setup", async () => {
		const { root, git, sha } = await repoWithDeps();
		const before = verifyDirs();

		await expect(
			withTempWorktree(git, root, sha, { run: RUN }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expectCleaned(root, before);

		const failed = await withTempWorktree(git, root, sha, { setup: "echo nope; exit 3", run: RUN }, async () => "ran");
		expect(failed).toEqual({ invalid: "setup", output: "nope\n" });
		expectCleaned(root, before);

		const slowSetup = await withTempWorktree(git, root, sha, { setup: "sleep 6", run: { ...RUN, timeoutS: 1 } }, async () => "ran");
		expect(slowSetup).toMatchObject({ invalid: "setup" });
		expectCleaned(root, before);

		const timed = await withTempWorktree(git, root, sha, { run: RUN }, (dir) =>
			runVerify("sleep 7", { ...RUN, cwd: dir, timeoutS: 1 }),
		);
		expect(timed).toMatchObject({ timedOut: true });
		expectCleaned(root, before);
	}, 20_000);

	test("abort kills the run and removes the worktree", async () => {
		const { root, git, sha } = await repoWithDeps();
		const before = verifyDirs();
		const controller = new AbortController();
		const run = { ...RUN, signal: controller.signal };
		const result = await withTempWorktree(git, root, sha, { run }, (dir) => {
			setTimeout(() => controller.abort(), 300);
			return runVerify("sleep 31", { ...run, cwd: dir });
		});
		expect(result).toMatchObject({ aborted: true });
		expectCleaned(root, before);

		const again = await withTempWorktree(git, root, sha, { setup: "true", run }, async () => "ran");
		expect(again).toEqual({ invalid: "aborted", output: "" });
		expectCleaned(root, before);
	}, 10_000);

	test("a stale worktree entry is pruned first", async () => {
		const { root, git, sha } = await repoWithDeps();
		const stale = join(await makeRepo(), "gone");
		await git.worktreeAdd(stale, sha);
		rmSync(stale, { recursive: true, force: true });
		expect(worktreeLines(root)).toHaveLength(2);
		await withTempWorktree(git, root, sha, { run: RUN }, async () => {
			expect(worktreeLines(root)).toHaveLength(2);
		});
		expect(worktreeLines(root)).toHaveLength(1);
	});
});
