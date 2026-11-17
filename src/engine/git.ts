// Typed git operations for the engine over the `GitExec` runner. Only the
// documented "not found" exits map to values; every other failure throws GitError.

import type { ProjectConfig } from "../config.ts";
import { defaultGitExec, type GitExec } from "./git-exec.ts";

export interface Git {
	branch(): Promise<string>;
	head(): Promise<string>;
	isDirty(): Promise<boolean>;
	diff(from: string, to: string, path: string): Promise<string>;
	/** `git diff --stat <from>..<to> -- <path>`. */
	diffStat(from: string, to: string, path: string): Promise<string>;
	/** `git diff --name-only <from>..<to> -- <path>`, one path per entry. */
	diffNames(from: string, to: string, path: string): Promise<string[]>;
	/** Default branch of `origin` (e.g. `main`, without the remote prefix), or undefined when `origin/HEAD` is not set. */
	originHead(): Promise<string | undefined>;
	fetch(remote: string, ref: string): Promise<void>;
	revParse(ref: string): Promise<string>;
	switchCreate(name: string, at: string): Promise<void>;
	switchTo(name: string): Promise<void>;
	deleteBranch(name: string): Promise<void>;
	branchExists(name: string): Promise<boolean>;
	configGet(key: string): Promise<string | undefined>;
	configSet(key: string, value: string): Promise<void>;
	/** `git merge --no-edit --no-ff -- <ref>`; `conflict` when it stops with unmerged paths (the merge is left in progress). */
	merge(ref: string): Promise<"ok" | "conflict">;
	/** `git merge --abort`: restores the tree and HEAD from before a conflicted merge. */
	mergeAbort(): Promise<void>;
	/** `git merge-base --is-ancestor <a> <b>`. */
	isAncestor(a: string, b: string): Promise<boolean>;
	/** `git worktree add --detach <dir> <sha>`. */
	worktreeAdd(dir: string, sha: string): Promise<void>;
	/** `git worktree remove --force <dir>`. */
	worktreeRemove(dir: string): Promise<void>;
	/** `git worktree prune`: drops entries whose directory is gone. */
	worktreePrune(): Promise<void>;
	/** `git rev-list --reverse <range>`, oldest first. */
	revList(range: string): Promise<string[]>;
	/** `git cat-file -e <sha>:<path>`. */
	pathExistsAt(sha: string, path: string): Promise<boolean>;
	/** `git diff-tree --no-commit-id --name-only -r --root <commit>`. */
	changedPaths(commit: string): Promise<string[]>;
	/** `git check-ignore -q <path>`. */
	isIgnored(path: string): Promise<boolean>;
	/** `git config --get-regexp ^alias\.`: alias name to its expansion; `{}` when none is set. */
	aliases(): Promise<Record<string, string>>;
}

export class GitError extends Error {
	constructor(
		readonly args: string[],
		readonly code: number | null,
		readonly stderr: string,
	) {
		super(`git ${args.join(" ")} failed (exit ${code ?? "none"}): ${stderr.trim()}`);
		this.name = "GitError";
	}
}

/** `symbolic-ref` exits 128 when the ref is missing or not symbolic. */
const EXIT_NOT_SYMBOLIC = 128;
/** `config --get` and `show-ref --verify --quiet` exit 1 when the key or ref is missing. */
const EXIT_NOT_FOUND = 1;
/** `merge` exits 1 when it stops, e.g. on a conflict. */
const EXIT_MERGE_STOPPED = 1;
/** `merge-base --is-ancestor` exits 1 when the first commit is not an ancestor of the second. */
const EXIT_NOT_ANCESTOR = 1;
const ORIGIN_PREFIX = "origin/";
/** `cat-file -e` exits 128 when the object or path does not exist. */
const EXIT_NO_OBJECT = 128;
/** `check-ignore` exits 1 when the path is not ignored. */
const EXIT_NOT_IGNORED = 1;
const ALIAS_PREFIX = "alias.";

/** Non-empty lines of a command's stdout. */
const lines = (out: string | undefined): string[] => (out ?? "").split("\n").filter((l) => l !== "");

/** `config -z --get-regexp` output: NUL-terminated entries of `<key>\n<value>`. */
function parseAliases(out: string): Record<string, string> {
	const entries = out
		.split("\0")
		.filter((entry) => entry.startsWith(ALIAS_PREFIX))
		.map((entry): [string, string] => {
			const newline = entry.indexOf("\n");
			const key = newline < 0 ? entry : entry.slice(0, newline);
			return [key.slice(ALIAS_PREFIX.length), newline < 0 ? "" : entry.slice(newline + 1)];
		});
	// `fromEntries` defines own properties, so a key such as `__proto__` stays plain data.
	return Object.fromEntries(entries);
}

type Run = (args: string[], notFoundCode?: number) => Promise<string | undefined>;

/** Runs git in `root`; returns stdout, `undefined` on `notFoundCode`, and throws GitError on any other failure. */
function runner(root: string, exec: GitExec): Run {
	return async (args, notFoundCode) => {
		const result = await exec(args, { cwd: root });
		if (result.code === 0) return result.stdout;
		if (notFoundCode !== undefined && result.code === notFoundCode) return undefined;
		throw new GitError(args, result.code, result.stderr || (result.spawnError ?? ""));
	};
}

/** Stdout of a command that cannot report "not found", trimmed. */
async function text(run: Run, args: string[]): Promise<string> {
	return ((await run(args)) ?? "").trim();
}

/**
 * Separates options from operands. Refs, remotes, branch names and config keys can come from an issue
 * (e.g. `Base:`), so every caller-supplied operand follows it and is never parsed as an option.
 */
const END_OF_OPTIONS = "--end-of-options";

export function createGit(root: string, exec: GitExec = defaultGitExec): Git {
	const run = runner(root, exec);
	return {
		branch: () => text(run, ["branch", "--show-current"]),
		head: () => text(run, ["rev-parse", "HEAD"]),
		isDirty: async () => (await text(run, ["status", "--porcelain"])) !== "",
		diff: async (from, to, path) => (await run(["diff", END_OF_OPTIONS, `${from}..${to}`, "--", path])) ?? "",
		diffStat: async (from, to, path) => (await run(["diff", "--stat", END_OF_OPTIONS, `${from}..${to}`, "--", path]))?.trimEnd() ?? "",
		diffNames: async (from, to, path) =>
			((await run(["diff", "--name-only", END_OF_OPTIONS, `${from}..${to}`, "--", path])) ?? "").split("\n").filter((l) => l !== ""),
		originHead: async () => {
			const ref = await run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], EXIT_NOT_SYMBOLIC);
			if (ref === undefined) return undefined;
			const name = ref.trim();
			return name.startsWith(ORIGIN_PREFIX) ? name.slice(ORIGIN_PREFIX.length) : name;
		},
		fetch: async (remote, ref) => {
			await run(["fetch", "--quiet", END_OF_OPTIONS, remote, ref]);
		},
		revParse: (ref) => text(run, ["rev-parse", "--verify", END_OF_OPTIONS, ref]),
		switchCreate: async (name, at) => {
			await run(["switch", "--quiet", "-c", name, END_OF_OPTIONS, at]);
		},
		switchTo: async (name) => {
			await run(["switch", "--quiet", END_OF_OPTIONS, name]);
		},
		deleteBranch: async (name) => {
			await run(["branch", "-D", END_OF_OPTIONS, name]);
		},
		branchExists: async (name) =>
			(await run(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], EXIT_NOT_FOUND)) !== undefined,
		configGet: async (key) => (await run(["config", "--get", END_OF_OPTIONS, key], EXIT_NOT_FOUND))?.trim(),
		configSet: async (key, value) => {
			await run(["config", END_OF_OPTIONS, key, value]);
		},
		merge: async (ref) => {
			const args = ["merge", "--no-edit", "--no-ff", "--", ref];
			if ((await run(args, EXIT_MERGE_STOPPED)) !== undefined) return "ok";
			if ((await text(run, ["diff", "--name-only", "--diff-filter=U"])) !== "") return "conflict";
			throw new GitError(args, EXIT_MERGE_STOPPED, "merge stopped without unmerged paths");
		},
		mergeAbort: async () => {
			await run(["merge", "--abort"]);
		},
		isAncestor: async (a, b) => (await run(["merge-base", "--is-ancestor", END_OF_OPTIONS, a, b], EXIT_NOT_ANCESTOR)) !== undefined,
		worktreeAdd: async (dir, sha) => {
			await run(["worktree", "add", "--quiet", "--detach", END_OF_OPTIONS, dir, sha]);
		},
		worktreeRemove: async (dir) => {
			await run(["worktree", "remove", "--force", END_OF_OPTIONS, dir]);
		},
		worktreePrune: async () => {
			await run(["worktree", "prune"]);
		},
		revList: async (range) => lines(await run(["rev-list", "--reverse", END_OF_OPTIONS, range])),
		pathExistsAt: async (sha, path) =>
			(await run(["cat-file", "-e", END_OF_OPTIONS, `${sha}:${path}`], EXIT_NO_OBJECT)) !== undefined,
		changedPaths: async (commit) =>
			lines(await run(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", END_OF_OPTIONS, commit])),
		isIgnored: async (path) => (await run(["check-ignore", "-q", "--", path], EXIT_NOT_IGNORED)) !== undefined,
		aliases: async () => parseAliases((await run(["config", "-z", "--get-regexp", "^alias\\."], EXIT_NOT_FOUND)) ?? ""),
	};
}

/** The project config key wins; otherwise the default branch of `origin`; `undefined` when neither is known. */
export async function integrationBranch(project: ProjectConfig, git: Git): Promise<string | undefined> {
	return project.integrationBranch ?? (await git.originHead());
}
