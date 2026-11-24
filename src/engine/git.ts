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
	/** `git diff --name-status -z -M <from>..<to>`; a rename carries `oldPath`. */
	diffNameStatus(from: string, to: string): Promise<DiffEntry[]>;
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
	/**
	 * `git merge --no-edit -- <ref>`, fast-forward allowed (sync with the integration branch); `conflict` when it
	 * stops with unmerged paths (the merge is left in progress).
	 */
	mergeOrigin(ref: string): Promise<"ok" | "conflict">;
	/** `git merge --abort`: restores the tree and HEAD from before a conflicted merge. */
	mergeAbort(): Promise<void>;
	/** `git merge-base --is-ancestor <a> <b>`. */
	isAncestor(a: string, b: string): Promise<boolean>;
	/** `git merge-base <a> <b>`: the best common ancestor. */
	mergeBase(a: string, b: string): Promise<string>;
	/**
	 * `git merge-tree --write-tree <a> <b>`: the tree a merge would write, without touching the work tree.
	 * `conflict` when the merge would conflict; `unsupported` when git predates `--write-tree` (2.38).
	 */
	mergeTree(a: string, b: string): Promise<{ tree: string } | "conflict" | "unsupported">;
	/** `git rev-parse <commit>^{tree}`. */
	treeOf(commit: string): Promise<string>;
	/** `git rev-parse --verify -q refs/remotes/<name>`; undefined when the ref is absent. */
	remoteRef(name: string): Promise<string | undefined>;
	/** `git rev-list --first-parent --reverse <range>`, oldest first. */
	firstParentList(range: string): Promise<string[]>;
	/**
	 * `git log --first-parent --reverse --format=%H%x00%s [--since=<since>] <after>..<commit>` (or `<commit>` without
	 * `after`): first-parent commits with their subjects, oldest first.
	 */
	firstParentCommits(commit: string, o: { after?: string; since?: string }): Promise<{ sha: string; subject: string }[]>;
	/** `git worktree add --detach <dir> <sha>`. */
	worktreeAdd(dir: string, sha: string): Promise<void>;
	/** `git worktree add -b <branch> <dir> <at>`. */
	worktreeAddBranch(dir: string, branch: string, at: string): Promise<void>;
	/** `git worktree remove --force <dir>`. */
	worktreeRemove(dir: string): Promise<void>;
	/** `git reset --hard <sha>`. */
	resetHard(sha: string): Promise<void>;
	/** `git worktree prune`: drops entries whose directory is gone. */
	worktreePrune(): Promise<void>;
	/** `git rev-list --reverse <range>`, oldest first. */
	revList(range: string): Promise<string[]>;
	/** `git cat-file -e <sha>:<path>`. */
	pathExistsAt(sha: string, path: string): Promise<boolean>;
	/** `git diff-tree --no-commit-id --name-only -r --root <commit>`; empty for an empty or a merge commit. */
	changedPaths(commit: string): Promise<string[]>;
	/** `git rev-list --parents -n 1 <commit>` without the commit itself: its parents, none for a root commit. */
	parents(commit: string): Promise<string[]>;
	/** `git check-ignore -q <path>`. */
	isIgnored(path: string): Promise<boolean>;
	/** `git config --get-regexp ^alias\.`: alias name to its expansion; `{}` when none is set. */
	aliases(): Promise<Record<string, string>>;
	/** `git diff --numstat -z -M <from>..<to>`; a rename is one entry with the new path, a binary file `binary: true` with 0/0. */
	diffNumstat(from: string, to: string): Promise<NumstatEntry[]>;
	/** `git ls-tree -r --name-only -z <rev>`: every file path at `rev`. */
	listTree(rev: string): Promise<string[]>;
	/** `git show <rev>:<path>`; undefined when the path does not exist at `rev`. */
	showFile(rev: string, path: string): Promise<string | undefined>;
	/** `git branch -m -- <from> <to>`. */
	renameBranch(from: string, to: string): Promise<void>;
	/** `git ls-files --error-unmatch -- <path>`. */
	isTracked(path: string): Promise<boolean>;
	/** `git log --reverse --no-merges --format=%s <from>..<to>`, oldest first. */
	subjects(from: string, to: string): Promise<string[]>;
	/** `git log --reverse --format=%H%x00%B%x00 <range>`: each commit's SHA and full message, oldest first. */
	messages(range: string): Promise<{ sha: string; message: string }[]>;
	/** `git add -A`: every tracked and untracked file that git does not ignore. */
	addAll(): Promise<void>;
	/** `git commit -m <message>` (with `--allow-empty` when asked); returns the new HEAD. */
	commit(message: string, o?: { allowEmpty?: boolean }): Promise<string>;
}

export type NumstatEntry = { path: string; added: number; deleted: number; binary: boolean };

/** `--numstat -z` output: `<added>\t<deleted>\t<path>\0`, and `<added>\t<deleted>\t\0<old>\0<new>\0` for a rename; `-` counts mean binary. */
function parseNumstat(out: string): NumstatEntry[] {
	const fields = out.split("\0");
	const entries: NumstatEntry[] = [];
	for (let i = 0; i < fields.length; ) {
		const record = fields[i++] as string;
		if (record === "") continue;
		const [added = "", deleted = "", ...rest] = record.split("\t");
		let path = rest.join("\t");
		if (path === "") {
			i++; // old path
			path = fields[i++] as string;
		}
		const binary = added === "-" || deleted === "-";
		entries.push({ path, added: binary ? 0 : Number(added), deleted: binary ? 0 : Number(deleted), binary });
	}
	return entries;
}

export type DiffEntry = { status: string; path: string; oldPath?: string };

/** Every `path` and `oldPath` of the entries, deduplicated. */
export function diffFilesOf(entries: DiffEntry[]): string[] {
	return [...new Set(entries.flatMap((e) => (e.oldPath === undefined ? [e.path] : [e.path, e.oldPath])))];
}

/** `--name-status -z` output: `<status>\0<path>\0`, and `R<score>\0<old>\0<new>\0` (or `C`) for a rename or copy. */
function parseNameStatus(out: string): DiffEntry[] {
	const fields = out.split("\0");
	const entries: DiffEntry[] = [];
	for (let i = 0; i < fields.length; ) {
		const code = fields[i++] as string;
		if (code === "") continue;
		const status = code.slice(0, 1);
		if (status === "R" || status === "C") {
			const oldPath = fields[i++] as string;
			entries.push({ status, path: fields[i++] as string, oldPath });
		} else {
			entries.push({ status, path: fields[i++] as string });
		}
	}
	return entries;
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
/** `ls-files --error-unmatch` exits 1 when the path is not tracked. */
const EXIT_NOT_TRACKED = 1;

/** `%H%x00%B%x00` log output: SHA and message fields alternate, each padded by the newline log adds between entries. */
function commitMessages(out: string | undefined): { sha: string; message: string }[] {
	const fields = (out ?? "").split("\0");
	const commits: { sha: string; message: string }[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) commits.push({ sha: (fields[i] as string).trim(), message: (fields[i + 1] as string).trim() });
	return commits;
}

/** Non-empty lines of a command's stdout. */
const lines = (out: string | undefined): string[] => (out ?? "").split("\n").filter((l) => l !== "");

/** `%H%x00%s` log lines: SHA and subject. */
const shaSubjects = (out: string | undefined): { sha: string; subject: string }[] =>
	lines(out).map((line) => {
		const at = line.indexOf("\0");
		return { sha: line.slice(0, at), subject: line.slice(at + 1) };
	});

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

/** `merge-tree --write-tree` exits 1 both on a conflict and on an unknown ref; only a conflict prints a tree. */
const EXIT_MERGE_CONFLICT = 1;
const TREE_LINE = /^[0-9a-f]{40,64}$/;
/** git before 2.38 rejects `--write-tree` with this usage error. */
const UNKNOWN_OPTION = /unknown option/i;

async function mergeTree(root: string, exec: GitExec, a: string, b: string): Promise<{ tree: string } | "conflict" | "unsupported"> {
	const args = ["merge-tree", "--write-tree", END_OF_OPTIONS, a, b];
	const result = await exec(args, { cwd: root });
	const tree = lines(result.stdout)[0] ?? "";
	if (result.code === 0 && TREE_LINE.test(tree)) return { tree };
	if (result.code === EXIT_MERGE_CONFLICT && TREE_LINE.test(tree)) return "conflict";
	if (UNKNOWN_OPTION.test(result.stderr)) return "unsupported";
	throw new GitError(args, result.code, result.stderr || (result.spawnError ?? ""));
}

/** Runs a `git merge`; a stop with unmerged paths is `conflict`, any other stop throws. */
async function runMerge(run: Run, args: string[]): Promise<"ok" | "conflict"> {
	if ((await run(args, EXIT_MERGE_STOPPED)) !== undefined) return "ok";
	if ((await text(run, ["diff", "--name-only", "--diff-filter=U"])) !== "") return "conflict";
	throw new GitError(args, EXIT_MERGE_STOPPED, "merge stopped without unmerged paths");
}

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
		diffNameStatus: async (from, to) =>
			parseNameStatus((await run(["diff", "--name-status", "-z", "-M", END_OF_OPTIONS, `${from}..${to}`])) ?? ""),
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
		merge: (ref) => runMerge(run, ["merge", "--no-edit", "--no-ff", "--", ref]),
		mergeOrigin: (ref) => runMerge(run, ["merge", "--no-edit", "--", ref]),
		mergeAbort: async () => {
			await run(["merge", "--abort"]);
		},
		isAncestor: async (a, b) => (await run(["merge-base", "--is-ancestor", END_OF_OPTIONS, a, b], EXIT_NOT_ANCESTOR)) !== undefined,
		mergeBase: (a, b) => text(run, ["merge-base", END_OF_OPTIONS, a, b]),
		mergeTree: (a, b) => mergeTree(root, exec, a, b),
		treeOf: (commit) => text(run, ["rev-parse", "--verify", END_OF_OPTIONS, `${commit}^{tree}`]),
		remoteRef: async (name) => (await run(["rev-parse", "--verify", "-q", END_OF_OPTIONS, `refs/remotes/${name}`], EXIT_NOT_FOUND))?.trim(),
		firstParentList: async (range) => lines(await run(["rev-list", "--first-parent", "--reverse", END_OF_OPTIONS, range])),
		firstParentCommits: async (commit, o) => {
			const since = o.since === undefined ? [] : [`--since=${o.since}`];
			const range = o.after === undefined ? commit : `${o.after}..${commit}`;
			return shaSubjects(await run(["log", "--first-parent", "--reverse", "--format=%H%x00%s", ...since, END_OF_OPTIONS, range]));
		},
		worktreeAdd: async (dir, sha) => {
			await run(["worktree", "add", "--quiet", "--detach", END_OF_OPTIONS, dir, sha]);
		},
		worktreeAddBranch: async (dir, branch, at) => {
			await run(["worktree", "add", "--quiet", "-b", branch, END_OF_OPTIONS, dir, at]);
		},
		worktreeRemove: async (dir) => {
			await run(["worktree", "remove", "--force", END_OF_OPTIONS, dir]);
		},
		resetHard: async (sha) => {
			await run(["reset", "--quiet", "--hard", END_OF_OPTIONS, sha]);
		},
		worktreePrune: async () => {
			await run(["worktree", "prune"]);
		},
		revList: async (range) => lines(await run(["rev-list", "--reverse", END_OF_OPTIONS, range])),
		pathExistsAt: async (sha, path) =>
			(await run(["cat-file", "-e", END_OF_OPTIONS, `${sha}:${path}`], EXIT_NO_OBJECT)) !== undefined,
		changedPaths: async (commit) =>
			lines(await run(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", END_OF_OPTIONS, commit])),
		parents: async (commit) => (await text(run, ["rev-list", "--parents", "-n", "1", END_OF_OPTIONS, commit])).split(" ").slice(1),
		isIgnored: async (path) => (await run(["check-ignore", "-q", "--", path], EXIT_NOT_IGNORED)) !== undefined,
		diffNumstat: async (from, to) => parseNumstat((await run(["diff", "--numstat", "-z", "-M", END_OF_OPTIONS, `${from}..${to}`])) ?? ""),
		listTree: async (rev) => ((await run(["ls-tree", "-r", "--name-only", "-z", END_OF_OPTIONS, rev])) ?? "").split("\0").filter((p) => p !== ""),
		showFile: (rev, path) => run(["show", END_OF_OPTIONS, `${rev}:${path}`], EXIT_NO_OBJECT),
		renameBranch: async (from, to) => {
			await run(["branch", "-m", "--", from, to]);
		},
		isTracked: async (path) => (await run(["ls-files", "--error-unmatch", "--", path], EXIT_NOT_TRACKED)) !== undefined,
		subjects: async (from, to) => lines(await run(["log", "--reverse", "--no-merges", "--format=%s", END_OF_OPTIONS, `${from}..${to}`])),
		messages: async (range) => commitMessages(await run(["log", "--reverse", "--format=%H%x00%B%x00", END_OF_OPTIONS, range])),
		addAll: async () => {
			await run(["add", "-A"]);
		},
		commit: async (message, o = {}) => {
			await run(["commit", "--quiet", ...(o.allowEmpty === true ? ["--allow-empty"] : []), "-m", message]);
			return text(run, ["rev-parse", "HEAD"]);
		},
		aliases: async () => parseAliases((await run(["config", "-z", "--get-regexp", "^alias\\."], EXIT_NOT_FOUND)) ?? ""),
	};
}

/** The project config key wins; otherwise the default branch of `origin`; `undefined` when neither is known. */
export async function integrationBranch(project: ProjectConfig, git: Git): Promise<string | undefined> {
	return project.integrationBranch ?? (await git.originHead());
}
