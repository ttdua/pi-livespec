import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { defaultGitExec as exec } from "../../src/engine/git-exec.ts";
import { deleteRefIf, readLedgerRefs } from "../../src/ledger/refs.ts";
import { isPending } from "../../src/ledger/sync.ts";
import { twoClones } from "./fixtures.ts";

const N = 1;
const LOCAL = `refs/livespec/${N}`;
const TRACKING = `refs/livespec-origin/${N}`;

function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** A repository with one commit; returns its clone path and commit sha. */
async function repoWithCommit(): Promise<{ root: string; commit: string }> {
	const { a } = await twoClones();
	const tree = git(a, ["hash-object", "-t", "tree", "-w", "--stdin"], "");
	const commit = git(a, ["commit-tree", tree, "-m", "c"]);
	return { root: a, commit };
}

describe("readLedgerRefs", () => {
	it("ignores refs nested under the ledger ref name", async () => {
		const { root, commit } = await repoWithCommit();
		git(root, ["update-ref", `${LOCAL}/x`, commit]);
		expect(await readLedgerRefs(exec, root, N)).toEqual({ local: undefined, tracking: undefined });
	});

	it("reads commits and treats non-commit objects as absent", async () => {
		const { root, commit } = await repoWithCommit();
		const blob = git(root, ["hash-object", "-w", "--stdin"], "x");
		git(root, ["update-ref", LOCAL, blob]);
		git(root, ["update-ref", TRACKING, commit]);
		expect(await readLedgerRefs(exec, root, N)).toEqual({ local: undefined, tracking: commit });
	});

	it("peels an annotated tag to its commit", async () => {
		const { root, commit } = await repoWithCommit();
		git(root, ["tag", "-a", "-m", "t", "tmp-tag", commit]);
		git(root, ["update-ref", LOCAL, git(root, ["rev-parse", "tmp-tag"])]);
		expect(await readLedgerRefs(exec, root, N)).toEqual({ local: commit, tracking: undefined });
	});
});

describe("deleteRefIf", () => {
	it("treats an already absent ref as deleted", async () => {
		const { root, commit } = await repoWithCommit();
		expect(await deleteRefIf(exec, root, LOCAL, commit)).toBe(true);
	});
});

describe("isPending", () => {
	it("is false when the tips are equal", async () => {
		const { root, commit } = await repoWithCommit();
		git(root, ["update-ref", LOCAL, commit]);
		git(root, ["update-ref", TRACKING, commit]);
		expect(await isPending(exec, root, N)).toBe(false);
	});

	it("is false when the local ref is absent", async () => {
		const { root, commit } = await repoWithCommit();
		git(root, ["update-ref", TRACKING, commit]);
		expect(await isPending(exec, root, N)).toBe(false);
	});

	it("is true when the tracking ref is absent", async () => {
		const { root, commit } = await repoWithCommit();
		git(root, ["update-ref", LOCAL, commit]);
		expect(await isPending(exec, root, N)).toBe(true);
	});

	it("is false when a ledger ref points at a blob", async () => {
		const { root } = await repoWithCommit();
		git(root, ["update-ref", LOCAL, git(root, ["hash-object", "-w", "--stdin"], "x")]);
		expect(await isPending(exec, root, N)).toBe(false);
	});
});
