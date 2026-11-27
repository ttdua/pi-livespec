import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type GitExec, defaultGitExec } from "../../src/engine/git-exec.ts";
import { type LedgerEntry, LedgerError } from "../../src/ledger/entry.ts";
import { appendEntry, commitEntries, readLedger, readTree } from "../../src/ledger/store.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";

const scratch: string[] = [];
afterEach(async () => {
	for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

const exec = defaultGitExec;
const LEDGER = "refs/livespec/59";

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

function tipOf(root: string): string | undefined {
	const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", LEDGER], { cwd: root, encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : undefined;
}

function show(root: string, path: string): string {
	return git(root, ["show", `${LEDGER}:${path}`]);
}

async function repoWithCommit(): Promise<string> {
	const root = await makeRepo();
	await writeIn(root, "README.md", "hello\n");
	commitAll(root);
	return root;
}

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "livespec-test-"));
	scratch.push(dir);
	return dir;
}

/** Commits `files` on top of `base` by hand, as a foreign writer would, and returns the commit sha. */
async function commitFiles(root: string, base: string, files: Record<string, string>): Promise<string> {
	const dir = await tempDir();
	const env = { GIT_INDEX_FILE: join(dir, "index") };
	git(root, ["read-tree", base], env);
	for (const [path, text] of Object.entries(files)) {
		const file = join(dir, "blob");
		await writeFile(file, text);
		const blob = git(root, ["hash-object", "-w", "--", file]);
		git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
	}
	const tree = git(root, ["write-tree"], env);
	return git(root, ["commit-tree", tree, "-p", base, "-m", "hand-written"]);
}

function entry(over: Partial<LedgerEntry> & Pick<LedgerEntry, "ref" | "kind" | "id">): LedgerEntry {
	return { seq: 1, at: "2026-11-27T10:00:00.000Z", data: {}, ...over };
}

describe("ledger append", () => {
	it("First record creates the ref", async () => {
		const root = await repoWithCommit();
		const appended = await appendEntry(exec, root, 59, { kind: "unit-start", id: "start.U1", data: { unit: "U1" } });

		expect(tipOf(root)).toBeDefined();
		expect(parse(show(root, "ledger.yaml"))).toEqual({ schema: 1, issue: 59 });
		const unitFile = parse(show(root, "units/U1.yaml")) as LedgerEntry[];
		expect(unitFile).toEqual([appended]);
		expect(appended).toMatchObject({ kind: "unit-start", id: "start.U1", seq: 1, data: { unit: "U1" } });
		expect(appended.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(appended.after).toBeUndefined();
		const mergeBase = spawnSync("git", ["merge-base", "HEAD", LEDGER], { cwd: root });
		expect(mergeBase.status).not.toBe(0);
		expect(git(root, ["log", "-1", "--format=%s", LEDGER])).toBe("livespec: unit-start start.U1");
	});

	it("Two records with the same id", async () => {
		const root = await repoWithCommit();
		const first = await appendEntry(exec, root, 59, { kind: "decision", id: "progress.U1", data: { attempt: 1 } });
		const second = await appendEntry(exec, root, 59, { kind: "decision", id: "progress.U1", data: { attempt: 2 }, after: "101" });

		const read = await readLedger(exec, root, 59);
		expect(read.warnings).toEqual([]);
		expect(read.entries.map((e) => [e.id, e.seq])).toEqual([
			["progress.U1", 1],
			["progress.U1", 2],
		]);
		expect(first.ref).not.toBe(second.ref);
		expect(read.entries[1]?.after).toBe("101");
		expect(show(root, "decisions.jsonl").split("\n")).toHaveLength(2);
	});

	it("Unknown kind refused", async () => {
		const root = await repoWithCommit();
		await appendEntry(exec, root, 59, { kind: "dispatch", id: "dispatch.U1", data: {} });
		const before = tipOf(root);

		const attempt = appendEntry(exec, root, 59, { kind: "lane" as never, id: "lane.U1", data: {} });
		await expect(attempt).rejects.toBeInstanceOf(LedgerError);
		await expect(attempt).rejects.toMatchObject({ code: "kind" });
		expect(tipOf(root)).toBe(before);
	});

	it("Two local sessions append at once", async () => {
		const root = await repoWithCommit();
		const lane = join(await tempDir(), "lane");
		git(root, ["worktree", "add", "-q", "-b", "lane", lane]);

		const [a, b] = await Promise.all([
			appendEntry(exec, root, 59, { kind: "dispatch", id: "dispatch.U1", data: { from: "change" } }),
			appendEntry(exec, lane, 59, { kind: "dispatch", id: "dispatch.U2", data: { from: "lane" } }),
		]);

		const read = await readLedger(exec, root, 59);
		expect(read.entries.map((e) => e.seq)).toEqual([1, 2]);
		expect(new Set(read.entries.map((e) => e.ref))).toEqual(new Set([a.ref, b.ref]));
	});

	it("Shared between worktrees", async () => {
		const root = await repoWithCommit();
		const lane = join(await tempDir(), "lane");
		git(root, ["worktree", "add", "-q", "-b", "lane", lane]);

		const appended = await appendEntry(exec, lane, 59, { kind: "dispatch", id: "dispatch.U1", data: { agent: "a1" } });

		const read = await readLedger(exec, root, 59);
		expect(read.entries).toEqual([appended]);
		expect(git(root, ["rev-parse", "--git-common-dir"])).toBe(".git");
	});

	it("Dirty tree does not matter", async () => {
		const root = await repoWithCommit();
		await writeIn(root, "README.md", "changed\n");
		await writeIn(root, "staged.txt", "staged\n");
		git(root, ["add", "staged.txt"]);
		await writeIn(root, "untracked.txt", "new\n");
		const status = git(root, ["status", "--porcelain"]);
		const cached = git(root, ["diff", "--cached"]);

		await appendEntry(exec, root, 59, { kind: "counter", id: "counter.review", data: { value: 1 } });

		expect(git(root, ["status", "--porcelain"])).toBe(status);
		expect(git(root, ["diff", "--cached"])).toBe(cached);
		expect(tipOf(root)).toBeDefined();
	});

	it("No git identity", async () => {
		const root = await repoWithCommit();
		git(root, ["config", "--unset", "user.name"]);
		git(root, ["config", "--unset", "user.email"]);
		const isolated = {
			HOME: await tempDir(),
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			EMAIL: "",
			GIT_AUTHOR_NAME: "",
			GIT_AUTHOR_EMAIL: "",
			GIT_COMMITTER_NAME: "",
			GIT_COMMITTER_EMAIL: "",
		};
		const bare: GitExec = (args, o = {}) => defaultGitExec(args, { ...o, env: { ...isolated, ...o.env } });

		await appendEntry(bare, root, 59, { kind: "dispatch", id: "dispatch.U1", data: {} });

		expect(git(root, ["log", "-1", "--format=%an <%ae>|%cn <%ce>", LEDGER])).toBe("livespec <livespec@localhost>|livespec <livespec@localhost>");
	});

	it("commits as livespec even when a git identity is configured", async () => {
		const root = await repoWithCommit();
		git(root, ["config", "user.name", "Someone"]);
		git(root, ["config", "user.email", "someone@example.com"]);

		await appendEntry(exec, root, 59, { kind: "dispatch", id: "dispatch.U1", data: {} });

		expect(git(root, ["log", "-1", "--format=%an <%ae>|%cn <%ce>", LEDGER])).toBe("livespec <livespec@localhost>|livespec <livespec@localhost>");
	});

	it("gives up after five lost compare-and-swaps and leaves the ref unchanged", async () => {
		const root = await repoWithCommit();
		await appendEntry(exec, root, 59, { kind: "dispatch", id: "dispatch.U1", data: {} });
		const before = tipOf(root);
		let swaps = 0;
		const contended: GitExec = (args, o) => {
			if (args[0] !== "update-ref") return defaultGitExec(args, o);
			swaps++;
			return Promise.resolve({ stdout: "", stderr: `fatal: cannot lock ref '${LEDGER}': is at 0000 but expected 1111`, code: 128 });
		};

		await expect(appendEntry(contended, root, 59, { kind: "dispatch", id: "dispatch.U2", data: {} })).rejects.toMatchObject({ code: "cas" });
		expect(swaps).toBe(6);
		expect(tipOf(root)).toBe(before);
	});

	it("refuses an issue number that is not a positive integer before any git call", async () => {
		let calls = 0;
		const counting: GitExec = (args, o) => {
			calls++;
			return defaultGitExec(args, o);
		};
		await expect(appendEntry(counting, await tempDir(), 0, { kind: "dispatch", id: "d", data: {} })).rejects.toBeInstanceOf(LedgerError);
		expect(calls).toBe(0);
	});
});

describe("invalid ledger content", () => {
	const summary = (ref: string, seq: number): LedgerEntry => entry({ ref, kind: "finding-summary", id: "findings.U1", seq });

	it("Corrupt line", async () => {
		const root = await repoWithCommit();
		const base = await commitEntries(exec, root, 59, undefined, [summary("findings.U1~00000001", 1)]);
		const good = git(root, ["show", `${base}:findings.jsonl`]);
		const bad = await commitFiles(root, base, { "findings.jsonl": `${good}\n{not json\n` });

		const read = await readTree(exec, root, bad, 59);
		expect(read.entries.map((e) => e.ref)).toEqual(["findings.U1~00000001"]);
		expect(read.warnings).toHaveLength(1);
		expect(read.warnings[0]).toContain("findings.jsonl");
	});

	it("Unknown schema", async () => {
		const root = await repoWithCommit();
		const base = await commitEntries(exec, root, 59, undefined, [summary("findings.U1~00000001", 1)]);
		const bad = await commitFiles(root, base, { "ledger.yaml": "schema: 2\nissue: 59\n" });

		const read = await readTree(exec, root, bad, 59);
		expect(read.entries).toEqual([]);
		expect(read.warnings).toHaveLength(1);
		expect(read.warnings[0]).toContain("schema");
	});

	it("reads a ledger of another issue as empty", async () => {
		const root = await repoWithCommit();
		const base = await commitEntries(exec, root, 60, undefined, [summary("findings.U1~00000001", 1)]);

		const read = await readTree(exec, root, base, 59);
		expect(read.entries).toEqual([]);
		expect(read.warnings[0]).toContain("issue");
	});

	it("skips a repeated ref with a warning", async () => {
		const root = await repoWithCommit();
		const base = await commitEntries(exec, root, 59, undefined, [summary("findings.U1~00000001", 1), summary("findings.U1~00000001", 2)]);

		const read = await readTree(exec, root, base, 59);
		expect(read.entries.map((e) => e.seq)).toEqual([1]);
		expect(read.warnings).toHaveLength(1);
		expect(read.warnings[0]).toContain("findings.U1~00000001");
	});

	it("skips a decision entry inside findings.jsonl with a warning", async () => {
		const root = await repoWithCommit();
		const base = await commitEntries(exec, root, 59, undefined, [summary("findings.U1~00000001", 1)]);
		const good = git(root, ["show", `${base}:findings.jsonl`]);
		const stray = JSON.stringify(entry({ ref: "progress.U1~00000002", kind: "decision", id: "progress.U1", seq: 2 }));
		const bad = await commitFiles(root, base, { "findings.jsonl": `${good}\n${stray}\n` });

		const read = await readTree(exec, root, bad, 59);
		expect(read.entries.map((e) => e.ref)).toEqual(["findings.U1~00000001"]);
		expect(read.warnings).toHaveLength(1);
		expect(read.warnings[0]).toContain("findings.jsonl");
		expect(read.warnings[0]).toContain("decision");
	});

	it("skips an entry that lacks a field and keeps file order across a seq gap", async () => {
		const root = await repoWithCommit();
		const base = await commitEntries(exec, root, 59, undefined, [summary("findings.U1~00000001", 1), summary("findings.U1~00000003", 5)]);
		const good = git(root, ["show", `${base}:findings.jsonl`]);
		const noData = JSON.stringify({ ref: "findings.U1~00000002", kind: "finding-summary", id: "findings.U1", seq: 2, at: "x" });
		const bad = await commitFiles(root, base, { "findings.jsonl": `${good}\n${noData}\n` });

		const read = await readTree(exec, root, bad, 59);
		expect(read.entries.map((e) => e.seq)).toEqual([1, 5]);
		expect(read.warnings).toHaveLength(1);
		expect(read.warnings[0]).toContain("data");
	});

	it("appends after hostile content without throwing", async () => {
		const root = await repoWithCommit();
		const base = await commitEntries(exec, root, 59, undefined, [summary("findings.U1~00000001", 1)]);
		const bad = await commitFiles(root, base, { "findings.jsonl": "garbage", "units/U1.yaml": "{ not: [ yaml" });
		git(root, ["update-ref", LEDGER, bad]);

		const appended = await appendEntry(exec, root, 59, { kind: "finding-summary", id: "findings.U1", data: {} });

		expect(appended.seq).toBe(1);
		const read = await readLedger(exec, root, 59);
		expect(read.entries.map((e) => e.ref)).toEqual([appended.ref]);
		expect(read.warnings.length).toBeGreaterThan(0);
	});
});
