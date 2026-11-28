import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ProjectConfig } from "../../src/config.ts";
import { createGit, diffFilesOf, type Git, GitError, integrationBranch } from "../../src/engine/git.ts";
import { defaultGitExec, type GitExec } from "../../src/engine/git-exec.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";

const PROJECT: ProjectConfig = { githubHosts: [], agentSkillsChannelSet: false, ledger: { retain: true } };

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

	test("diffNames keeps a non-ASCII name with a space unquoted", async () => {
		const { root, git } = await committedRepo();
		const base = await git.head();
		await writeIn(root, "specs/naïve cap/spec.md", "# x\n");
		commitAll(root, "unicode");
		expect(await git.diffNames(base, "HEAD", "specs/")).toEqual(["specs/naïve cap/spec.md"]);
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

	test("mergeOrigin fast-forwards when HEAD is behind", async () => {
		const { root, git, side } = await divergent(false);
		execFileSync("git", ["reset", "-q", "--hard", "HEAD~1"], { cwd: root });
		expect(await git.mergeOrigin("side")).toBe("ok");
		expect(await git.head()).toBe(side);
	});

	test("mergeOrigin merges diverged history and reports a conflict", async () => {
		const clean = await divergent(false);
		const head = await clean.git.head();
		expect(await clean.git.mergeOrigin("side")).toBe("ok");
		expect(await clean.git.parents("HEAD")).toEqual([head, clean.side]);
		const conflicted = await divergent(true);
		expect(await conflicted.git.mergeOrigin("side")).toBe("conflict");
		await conflicted.git.mergeAbort();
		expect(existsSync(`${conflicted.root}/.git/MERGE_HEAD`)).toBe(false);
	});

	test("mergeBase names the fork point", async () => {
		const { root, git, side } = await divergent(false);
		const fork = gitIn(root, "rev-parse", "HEAD~1");
		expect(await git.mergeBase("HEAD", side)).toBe(fork);
	});

	test("mergeTree of a clean merge equals the tree of the --no-ff merge commit", async () => {
		const { git, side } = await divergent(false);
		const predicted = await git.mergeTree("HEAD", side);
		expect(await git.merge("side")).toBe("ok");
		expect(predicted).toEqual({ tree: await git.treeOf("HEAD") });
	});

	test("mergeTree of conflicting edits is conflict and leaves the work tree alone", async () => {
		const { git, side } = await divergent(true);
		expect(await git.mergeTree("HEAD", side)).toBe("conflict");
		expect(await git.isDirty()).toBe(false);
	});

	test("mergeTree is unsupported when git does not know --write-tree", async () => {
		const { root } = await committedRepo();
		const old: GitExec = async (args, opts) =>
			args[0] === "merge-tree" ? { stdout: "", stderr: "error: unknown option `write-tree'\nusage: git merge-tree <base-tree> <branch1> <branch2>\n", code: 129 } : defaultGitExec(args, opts);
		expect(await createGit(root, old).mergeTree("HEAD", "HEAD")).toBe("unsupported");
	});

	test("mergeTree throws GitError on any other failure", async () => {
		const { git } = await committedRepo();
		await expect(git.mergeTree("HEAD", "0".repeat(40))).rejects.toBeInstanceOf(GitError);
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

	test("treeOf names the tree of a commit", async () => {
		const { root, git } = await committedRepo();
		expect(await git.treeOf("HEAD")).toBe(gitIn(root, "rev-parse", "HEAD^{tree}"));
	});

	test("remoteRef resolves a remote-tracking ref, undefined when it is absent", async () => {
		const root = await cloneWithOriginHead();
		expect(await createGit(root).remoteRef("origin/main")).toBe(gitIn(root, "rev-parse", "origin/main"));
		expect(await createGit(root).remoteRef("origin/x")).toBeUndefined();
	});

	test("firstParentList lists only the branch's first-parent commits after merging main", async () => {
		const { root, git } = await committedRepo();
		const main = currentBranch(root);
		const base = await git.head();
		gitIn(root, "switch", "-q", "-c", "feature");
		await writeIn(root, "f.txt", "f\n");
		commitAll(root, "feature work");
		const own = await git.head();
		gitIn(root, "switch", "-q", main);
		await writeIn(root, "m.txt", "m\n");
		commitAll(root, "main work");
		const onMain = await git.head();
		gitIn(root, "switch", "-q", "feature");
		expect(await git.merge(main)).toBe("ok");
		const merge = await git.head();
		const listed = await git.firstParentList(`${base}..HEAD`);
		expect(listed).toEqual([own, merge]);
		expect(listed).not.toContain(onMain);
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

describe("diffNameStatus", () => {
	test("reports modified, deleted and renamed files; diffFilesOf lists all four paths", async () => {
		const root = await makeRepo();
		await writeIn(root, "mod.txt", "one\n");
		await writeIn(root, "del.txt", "gone\n");
		await writeIn(root, "old name.txt", "a rename needs enough content to be detected\nline 2\nline 3\n");
		commitAll(root);
		const g = createGit(root);
		const base = await g.head();
		await writeIn(root, "mod.txt", "two\n");
		git(root, "rm", "-q", "del.txt");
		git(root, "mv", "old name.txt", "new name.txt");
		commitAll(root, "change");
		const entries = await g.diffNameStatus(base, await g.head());
		expect(entries).toContainEqual({ status: "M", path: "mod.txt" });
		expect(entries).toContainEqual({ status: "D", path: "del.txt" });
		expect(entries).toContainEqual({ status: "R", path: "new name.txt", oldPath: "old name.txt" });
		expect(diffFilesOf(entries).sort()).toEqual(["del.txt", "mod.txt", "new name.txt", "old name.txt"]);
	});
});

describe("small-fix ports", () => {
	async function twoCommits(): Promise<{ root: string; git: Git; base: string }> {
		const root = await makeRepo();
		await writeIn(root, "a.txt", "one\ntwo\n");
		commitAll(root, "base");
		return { root, git: createGit(root), base: git(root, "rev-parse", "HEAD") };
	}

	test("diffNumstat counts lines and flags binary files", async () => {
		const { root, git: g, base } = await twoCommits();
		await writeIn(root, "a.txt", "one\nthree\nfour\n");
		execFileSync("sh", ["-c", "printf '\\000\\001\\002' > bin.dat"], { cwd: root });
		commitAll(root, "change");
		const entries = await g.diffNumstat(base, "HEAD");
		expect(entries).toContainEqual({ path: "a.txt", added: 2, deleted: 1, binary: false });
		expect(entries).toContainEqual({ path: "bin.dat", added: 0, deleted: 0, binary: true });
	});

	test("rename reports the new path once", async () => {
		const { root, git: g, base } = await twoCommits();
		git(root, "mv", "a.txt", "b.txt");
		await writeIn(root, "b.txt", "one\ntwo\nthree\n");
		commitAll(root, "rename");
		const entries = await g.diffNumstat(base, "HEAD");
		expect(entries.map((e) => e.path)).toEqual(["b.txt"]);
		expect(entries[0]).toMatchObject({ added: 1, deleted: 0, binary: false });
	});

	test("showFile returns content or undefined", async () => {
		const { git: g } = await twoCommits();
		expect(await g.showFile("HEAD", "missing")).toBeUndefined();
		expect(await g.showFile("HEAD", "a.txt")).toBe("one\ntwo\n");
	});

	test("renameBranch keeps HEAD and removes the old name", async () => {
		const { root, git: g } = await twoCommits();
		git(root, "switch", "-q", "-c", "fix/x");
		const sha = git(root, "rev-parse", "HEAD");
		await g.renameBranch("fix/x", "livespec/y");
		expect(git(root, "rev-parse", "HEAD")).toBe(sha);
		expect(await g.branchExists("fix/x")).toBe(false);
		expect(await g.branchExists("livespec/y")).toBe(true);
	});

	test("isTracked distinguishes committed and untracked files", async () => {
		const { root, git: g } = await twoCommits();
		await writeIn(root, "new.txt", "x\n");
		expect(await g.isTracked("a.txt")).toBe(true);
		expect(await g.isTracked("new.txt")).toBe(false);
	});

	test("subjects lists commit subjects oldest first and skips merges", async () => {
		const { root, git: g, base } = await twoCommits();
		const main = git(root, "branch", "--show-current");
		git(root, "switch", "-q", "-c", "side");
		await writeIn(root, "s.txt", "s\n");
		commitAll(root, "side work");
		git(root, "switch", "-q", main);
		await writeIn(root, "m.txt", "m\n");
		commitAll(root, "main work");
		git(root, "merge", "--no-ff", "-q", "-m", "merge side", "side");
		expect(await g.subjects(base, "HEAD")).toEqual(["side work", "main work"]);
	});

	test("messages lists full commit messages of a range, merges included", async () => {
		const { root, git: g, base } = await twoCommits();
		await writeIn(root, "b.txt", "b\n");
		commitAll(root, "subject\n\nbody line\nFixes #3");
		const sha = git(root, "rev-parse", "HEAD");
		expect(await g.messages(`${base}..HEAD`)).toEqual([{ sha, message: "subject\n\nbody line\nFixes #3" }]);
		expect(await g.messages("HEAD..HEAD")).toEqual([]);
	});
});

describe("park ports", () => {
	test("addAll and commit take untracked and modified files, not ignored ones", async () => {
		const { root, git: g } = await committedRepo();
		await writeIn(root, ".gitignore", "build/\n");
		commitAll(root, "ignore build");
		const before = await g.head();
		await writeIn(root, "README.md", "changed\n");
		await writeIn(root, "new.txt", "n\n");
		await writeIn(root, "build/out.txt", "o\n");
		await g.addAll();
		const head = await g.commit("wip(U2): parked for #41");
		expect(head).toBe(git(root, "rev-parse", "HEAD"));
		expect(await g.parents(head)).toEqual([before]);
		expect((await g.changedPaths(head)).sort()).toEqual(["README.md", "new.txt"]);
		expect(git(root, "log", "-1", "--format=%s")).toBe("wip(U2): parked for #41");
		expect(await g.isTracked("build/out.txt")).toBe(false);
	});

	test("commit with allowEmpty records a commit on a clean tree", async () => {
		const { git: g } = await committedRepo();
		const before = await g.head();
		await expect(g.commit("empty")).rejects.toBeInstanceOf(GitError);
		const head = await g.commit("empty", { allowEmpty: true });
		expect(await g.parents(head)).toEqual([before]);
	});
});

describe("listTree", () => {
	test("lists every file path at a revision", async () => {
		const root = await makeRepo();
		await writeIn(root, "a.txt", "1\n");
		await writeIn(root, "specs/x/spec.md", "2\n");
		await writeIn(root, "we ird/é.md", "3\n");
		commitAll(root);
		expect((await createGit(root).listTree("HEAD")).sort()).toEqual(["a.txt", "specs/x/spec.md", "we ird/é.md"]);
	});
});

describe("firstParentCommits", () => {
	const DAY_S = 86_400;
	const commitAt = (root: string, message: string, daysAgo?: number): string => {
		const env = { ...process.env };
		if (daysAgo !== undefined) {
			const at = `${Math.floor(Date.now() / 1000) - daysAgo * DAY_S} +0000`;
			env.GIT_COMMITTER_DATE = at;
			env.GIT_AUTHOR_DATE = at;
		}
		execFileSync("git", ["commit", "-q", "--allow-empty", "-m", message], { cwd: root, env });
		return git(root, "rev-parse", "HEAD");
	};

	test("after a commit: first-parent commits only, oldest first, with subjects", async () => {
		const { root } = await committedRepo();
		git(root, "branch", "-M", "main");
		const start = git(root, "rev-parse", "HEAD");
		const a = commitAt(root, "feat: a (#1)");
		git(root, "switch", "-q", "-c", "side");
		const side = commitAt(root, "side only");
		git(root, "switch", "-q", "main");
		git(root, "merge", "-q", "--no-ff", "-m", "Merge pull request #2 from x/side", "side");
		const merge = git(root, "rev-parse", "HEAD");
		const b = commitAt(root, "fix: b (#3)");
		const out = await createGit(root).firstParentCommits(merge, { after: start });
		expect(out).toEqual([
			{ sha: a, subject: "feat: a (#1)" },
			{ sha: merge, subject: "Merge pull request #2 from x/side" },
		]);
		expect(out.map((c) => c.sha)).not.toContain(side);
		expect(out.map((c) => c.sha)).not.toContain(b);
	});

	test("since: a commit 31 days old is excluded, one 29 days old included", async () => {
		const root = await makeRepo();
		commitAt(root, "old", 31);
		const recent = commitAt(root, "recent", 29);
		expect(await createGit(root).firstParentCommits("HEAD", { since: "30.days" })).toEqual([{ sha: recent, subject: "recent" }]);
	});

	test("nothing after the commit itself", async () => {
		const { root } = await committedRepo();
		const head = git(root, "rev-parse", "HEAD");
		expect(await createGit(root).firstParentCommits(head, { after: head })).toEqual([]);
	});
});

describe("commitPaths", () => {
	test("a plain commit lists its files; a merge lists what it brought to its first parent", async () => {
		const { root, git: g } = await committedRepo();
		git(root, "branch", "-M", "main");
		await writeIn(root, "a.txt", "a\n");
		commitAll(root, "a");
		expect(await g.commitPaths("HEAD")).toEqual(["a.txt"]);
		git(root, "switch", "-q", "-c", "side");
		await writeIn(root, "src/limit/cap.ts", "x\n");
		commitAll(root, "cap");
		git(root, "switch", "-q", "main");
		await writeIn(root, "b.txt", "b\n");
		commitAll(root, "b");
		git(root, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "merge side", "side");
		expect(await g.commitPaths("HEAD")).toEqual(["src/limit/cap.ts"]);
	});

	test("names with non-ASCII characters and spaces are returned unquoted, for a plain commit and a merge", async () => {
		const { root, git: g } = await committedRepo();
		git(root, "branch", "-M", "main");
		await writeIn(root, "src/limit/é.ts", "x\n");
		await writeIn(root, "src/limit/a b.ts", "x\n");
		commitAll(root, "odd names");
		expect(await g.commitPaths("HEAD")).toEqual(["src/limit/a b.ts", "src/limit/é.ts"]);
		expect(await g.changedPaths("HEAD")).toEqual(["src/limit/a b.ts", "src/limit/é.ts"]);
		git(root, "switch", "-q", "-c", "side");
		await writeIn(root, "src/limit/ü x.ts", "x\n");
		commitAll(root, "side");
		git(root, "switch", "-q", "main");
		await writeIn(root, "b.txt", "b\n");
		commitAll(root, "b");
		git(root, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "merge side", "side");
		expect(await g.commitPaths("HEAD")).toEqual(["src/limit/ü x.ts"]);
	});
});

describe("commonDir", () => {
	test("absolute, and the same from a linked worktree", async () => {
		const { root, git: g } = await committedRepo();
		const common = await g.commonDir();
		expect(isAbsolute(common)).toBe(true);
		expect(realpathSync(common)).toBe(realpathSync(join(root, ".git")));
		const linked = join(await makeRepo(), "linked");
		git(root, "worktree", "add", "-q", "--detach", linked);
		expect(realpathSync(await createGit(linked).commonDir())).toBe(realpathSync(common));
	});
});

describe("hasCommit", () => {
	test("HEAD is a commit", async () => {
		const { root, git } = await committedRepo();
		expect(await git.hasCommit(await gitHead(root))).toBe(true);
	});

	test("a commit dropped by reset --hard HEAD~1 is still a commit object", async () => {
		const { root, git: repo } = await committedRepo();
		await writeIn(root, "second.txt", "y\n");
		commitAll(root, "second");
		const dropped = await gitHead(root);
		git(root, "reset", "-q", "--hard", "HEAD~1");
		expect(await repo.hasCommit(dropped)).toBe(true);
	});

	test("an unknown sha is not a commit", async () => {
		const { git } = await committedRepo();
		expect(await git.hasCommit("0".repeat(40))).toBe(false);
	});
});

async function gitHead(root: string): Promise<string> {
	return git(root, "rev-parse", "HEAD");
}
