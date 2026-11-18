import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { ProjectConfig } from "../../src/config.ts";
import { createGit, type Git, GitError, integrationBranch } from "../../src/engine/git.ts";
import { defaultGitExec, type GitExec } from "../../src/engine/git-exec.ts";
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

describe("diff over specs", () => {
	test("diffStat diffNames over specs", async () => {
		const { root, git } = await committedRepo();
		const base = await git.head();
		await writeIn(root, "specs/rate-limit/spec.md", "# rate-limit\n");
		await writeIn(root, "specs/auth/spec.md", "# auth\n");
		await writeIn(root, "src/x.ts", "x\n");
		commitAll(root, "specs");
		expect(await git.diffNames(base, "HEAD", "specs/")).toEqual(["specs/auth/spec.md", "specs/rate-limit/spec.md"]);
		const stat = await git.diffStat(base, "HEAD", "specs/");
		expect(stat).toContain("specs/rate-limit/spec.md | 1 +");
		expect(stat).toContain("2 files changed, 2 insertions(+)");
		expect(stat).not.toContain("src/x.ts");
		expect(await git.diffNames("HEAD", "HEAD", "specs/")).toEqual([]);
		expect(await git.diffStat("HEAD", "HEAD", "specs/")).toBe("");
		await expect(git.diffNames("0".repeat(40), "HEAD", "specs/")).rejects.toBeInstanceOf(GitError);
	});
});

describe("merge", () => {
	/** A repo with `main` and a `side` branch that both changed README.md, or only `side` when `conflict` is false. */
	async function divergent(conflict: boolean): Promise<{ root: string; git: Git; side: string }> {
		const { root } = await committedRepo();
		const start = currentBranch(root);
		execFileSync("git", ["switch", "-q", "-c", "side"], { cwd: root });
		await writeIn(root, conflict ? "README.md" : "side.txt", "side\n");
		commitAll(root, "side");
		const side = await createGit(root).head();
		execFileSync("git", ["switch", "-q", start], { cwd: root });
		await writeIn(root, "README.md", "main\n");
		commitAll(root, "main");
		execFileSync("git", ["config", "user.name", "t"], { cwd: root });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
		return { root, git: createGit(root), side };
	}

	test("merge reports conflict and mergeAbort restores the tree", async () => {
		const { root, git } = await divergent(true);
		const head = await git.head();
		expect(await git.merge("side")).toBe("conflict");
		await git.mergeAbort();
		expect(await git.head()).toBe(head);
		expect(await git.isDirty()).toBe(false);
		expect(existsSync(`${root}/.git/MERGE_HEAD`)).toBe(false);
	});

	test("merge without a conflict makes a merge commit", async () => {
		const { git, side } = await divergent(false);
		const head = await git.head();
		expect(await git.merge("side")).toBe("ok");
		expect(await git.head()).not.toBe(head);
		expect(await git.isAncestor(side, "HEAD")).toBe(true);
		expect(await git.isAncestor(head, "HEAD")).toBe(true);
	});

	test("isAncestor", async () => {
		const { git, side } = await divergent(false);
		const head = await git.head();
		expect(await git.isAncestor(side, head)).toBe(false);
		expect(await git.isAncestor(head, head)).toBe(true);
		await expect(git.isAncestor("0".repeat(40), head)).rejects.toBeInstanceOf(GitError);
	});
});

describe("verify additions", () => {
	test("worktreeAdd, worktreeRemove and worktreePrune manage detached worktrees", async () => {
		const { root, git } = await committedRepo();
		const sha = await git.head();
		const dir = `${await makeRepo()}/wt`;
		await git.worktreeAdd(dir, sha);
		expect(existsSync(`${dir}/README.md`)).toBe(true);
		expect(gitIn(dir, "rev-parse", "HEAD")).toBe(sha);
		expect(gitIn(dir, "branch", "--show-current")).toBe("");
		await git.worktreeRemove(dir);
		expect(existsSync(dir)).toBe(false);
		await git.worktreeAdd(dir, sha);
		execFileSync("rm", ["-rf", dir]);
		expect(worktreeCount(root)).toBe(2);
		await git.worktreePrune();
		expect(worktreeCount(root)).toBe(1);
	});

	test("revList lists commits oldest first", async () => {
		const { root, git } = await committedRepo();
		const base = await git.head();
		await writeIn(root, "a.txt", "a\n");
		commitAll(root, "a");
		const a = await git.head();
		await writeIn(root, "b.txt", "b\n");
		commitAll(root, "b");
		const b = await git.head();
		expect(await git.revList(`${base}..HEAD`)).toEqual([a, b]);
		expect(await git.revList("HEAD..HEAD")).toEqual([]);
	});

	test("pathExistsAt checks a path at a commit", async () => {
		const { root, git } = await committedRepo();
		const base = await git.head();
		await writeIn(root, "tests/x.test.ts", "t\n");
		commitAll(root, "t");
		expect(await git.pathExistsAt(base, "README.md")).toBe(true);
		expect(await git.pathExistsAt(base, "tests/x.test.ts")).toBe(false);
		expect(await git.pathExistsAt("HEAD", "tests/x.test.ts")).toBe(true);
	});

	test("changedPaths lists the files of one commit, the root commit included", async () => {
		const { root, git } = await committedRepo();
		expect(await git.changedPaths("HEAD")).toEqual(["README.md"]);
		await writeIn(root, "src/a.ts", "a\n");
		await writeIn(root, "tests/a.test.ts", "t\n");
		commitAll(root, "two");
		expect(await git.changedPaths("HEAD")).toEqual(["src/a.ts", "tests/a.test.ts"]);
	});

	test("parents lists a commit's parents; a merge has two", async () => {
		const { root, git } = await committedRepo();
		const base = await git.head();
		expect(await git.parents(base)).toEqual([]);
		await writeIn(root, "a.txt", "a\n");
		commitAll(root, "a");
		const a = await git.head();
		expect(await git.parents(a)).toEqual([base]);
		const merge = execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", "HEAD^{tree}", "-p", a, "-p", base, "-m", "m"], { cwd: root, encoding: "utf8" }).trim();
		expect(await git.parents(merge)).toEqual([a, base]);
	});

	test("isIgnored follows .gitignore", async () => {
		const { root, git } = await committedRepo();
		await writeIn(root, ".gitignore", "node_modules/\n");
		await writeIn(root, "node_modules/x/y.js", "y\n");
		expect(await git.isIgnored("node_modules")).toBe(true);
		expect(await git.isIgnored("README.md")).toBe(false);
	});

	test("aliases reads git aliases, and is empty without any", async () => {
		const { root } = await committedRepo();
		// Reads only the repository's config, never the user's global or system aliases.
		const isolated: GitExec = (args, opts = {}) =>
			defaultGitExec(args, { ...opts, env: { ...opts.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		const git = createGit(root, isolated);
		expect(await git.aliases()).toEqual({});
		gitIn(root, "config", "alias.p", "push origin");
		gitIn(root, "config", "alias.st", "status --short");
		expect(await git.aliases()).toEqual({ p: "push origin", st: "status --short" });
	});
});

function gitIn(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function worktreeCount(root: string): number {
	return gitIn(root, "worktree", "list").split("\n").filter(Boolean).length;
}
