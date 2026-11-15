import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { ProjectConfig } from "../../src/config.ts";
import { createGit, type Git, GitError, integrationBranch } from "../../src/engine/git.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";

const PROJECT: ProjectConfig = { githubHosts: [], agentSkillsChannelSet: false };

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A clone of a local bare upstream whose default branch is `main`; `origin/HEAD` is set by the clone. */
async function cloneWithOriginHead(): Promise<string> {
	const seed = await makeRepo();
	git(seed, "checkout", "-q", "-b", "main");
	await writeIn(seed, "README.md", "x\n");
	commitAll(seed);
	const parent = await makeRepo();
	git(parent, "clone", "-q", "--bare", seed, "upstream.git");
	git(parent, "clone", "-q", `${parent}/upstream.git`, "work");
	return `${parent}/work`;
}

async function committedRepo(): Promise<{ root: string; git: Git }> {
	const root = await makeRepo();
	await writeIn(root, "README.md", "x\n");
	commitAll(root);
	return { root, git: createGit(root) };
}

describe("integration branch", () => {
	test("integrationBranch prefers config", async () => {
		const root = await cloneWithOriginHead();
		const branch = await integrationBranch({ ...PROJECT, integrationBranch: "develop" }, createGit(root));
		expect(branch).toBe("develop");
	});

	test("Default branch", async () => {
		const root = await cloneWithOriginHead();
		expect(await integrationBranch(PROJECT, createGit(root))).toBe("main");
	});

	test("Cannot resolve", async () => {
		const { git } = await committedRepo();
		expect(await integrationBranch(PROJECT, git)).toBeUndefined();
	});
});

describe("createGit", () => {
	test("isDirty detects untracked files", async () => {
		const { root, git } = await committedRepo();
		expect(await git.isDirty()).toBe(false);
		await writeIn(root, "new.txt", "y\n");
		expect(await git.isDirty()).toBe(true);
	});

	test("configSet then configGet round-trips", async () => {
		const { git } = await committedRepo();
		await git.configSet("branch.livespec/x.livespecBase", "abc123");
		expect(await git.configGet("branch.livespec/x.livespecBase")).toBe("abc123");
	});

	test("configGet returns undefined for a missing key", async () => {
		const { git } = await committedRepo();
		expect(await git.configGet("livespec.nothing")).toBeUndefined();
	});

	test("branchExists is false for a missing branch", async () => {
		const { root, git } = await committedRepo();
		expect(await git.branchExists("nope")).toBe(false);
		expect(await git.branchExists(currentBranch(root))).toBe(true);
	});

	test("branch, head, revParse and diff read the repository", async () => {
		const { root, git } = await committedRepo();
		const base = await git.head();
		expect(base).toMatch(/^[0-9a-f]{40}$/);
		expect(await git.revParse("HEAD")).toBe(base);
		expect(await git.branch()).toBe(currentBranch(root));
		await writeIn(root, "specs/auth/spec.md", "# auth\n");
		commitAll(root, "spec");
		expect(await git.diff(base, "HEAD", "specs/")).toContain("specs/auth/spec.md");
	});

	test("switchCreate, switchTo and deleteBranch manage branches", async () => {
		const { root, git } = await committedRepo();
		const start = currentBranch(root);
		await git.switchCreate("livespec/x", await git.head());
		expect(await git.branch()).toBe("livespec/x");
		await git.switchTo(start);
		await git.deleteBranch("livespec/x");
		expect(await git.branchExists("livespec/x")).toBe(false);
	});

	test("option-like Base is rejected by diff and not executed as an option", async () => {
		const { root, git } = await committedRepo();
		const target = `${root}/pwned`;
		const failure = await git.diff(`--output=${target}`, "HEAD", "specs/").catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(GitError);
		expect(existsSync(`${target}..HEAD`)).toBe(false);
		expect(existsSync(target)).toBe(false);
	});

	test("option-like refs are not parsed as options by any ref-taking call", async () => {
		const { root, git } = await committedRepo();
		const evil = `--output=${root}/pwned`;
		await expect(git.revParse(evil)).rejects.toBeInstanceOf(GitError);
		await expect(git.switchCreate("x", evil)).rejects.toBeInstanceOf(GitError);
		await expect(git.switchTo("--detach")).rejects.toBeInstanceOf(GitError);
		await expect(git.deleteBranch("--all")).rejects.toBeInstanceOf(GitError);
		await expect(git.fetch("--upload-pack=touch pwned", "HEAD")).rejects.toBeInstanceOf(GitError);
		expect(await git.configGet("--list")).toBeUndefined();
		expect(existsSync(`${root}/pwned`)).toBe(false);
		expect(await git.branch()).toBe(currentBranch(root));
	});

	test("unexpected git failure throws GitError with stderr", async () => {
		const { git } = await committedRepo();
		const failure = await git.revParse("no-such-ref").catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(GitError);
		const error = failure as GitError;
		expect(error.code).not.toBe(0);
		expect(error.args).toContain("no-such-ref");
		expect(error.stderr).not.toBe("");
	});
});

function currentBranch(root: string): string {
	return git(root, "branch", "--show-current");
}
