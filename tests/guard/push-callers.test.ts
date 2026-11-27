import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultGitExec } from "../../src/engine/git-exec.ts";
import { GitError } from "../../src/engine/git.ts";
import type { GitExec } from "../../src/engine/git-exec.ts";
import { guardedDeleteWip, guardedPush, ledgerDelete, ledgerFetch, ledgerPush } from "../../src/guard/push.ts";
import { commitAll, writeIn } from "../helpers/repo.ts";
import { cleanupDirs, originRefs, textOf, toolHarness } from "../tools/helpers.ts";
import { BRANCH, parkHarness } from "../tools/park-fixture.ts";
import { afterEach } from "vitest";

afterEach(cleanupDirs);

const SRC_DIR = new URL("../../src/", import.meta.url).pathname;

function sourcesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		if (e.isDirectory()) return sourcesUnder(path);
		return e.name.endsWith(".ts") ? [path] : [];
	});
}

describe("command-guards", () => {
	test("No tool calls the push path", () => {
		const sources = sourcesUnder(SRC_DIR);
		expect(sources.length).toBeGreaterThan(0);
		const importing = sources.filter((path) => !path.endsWith("/guard/push.ts") && /guard\/push(\.ts)?["']|from "\.\/push(\.ts)?"/.test(readFileSync(path, "utf8")));
		const allowed = new Set(["change-ship.ts", "change-push.ts", "fix-ship.ts", "change-park.ts", "change-resume.ts"]);
		expect(importing.map((path) => basename(path)).filter((name) => !allowed.has(name))).toEqual([]);
		expect(importing.map((path) => basename(path))).toContain("change-ship.ts");
		expect(importing.map((path) => basename(path))).toContain("change-park.ts");
		const others = sources.filter((path) => !path.endsWith("/guard/push.ts"));
		expect(others.filter((path) => readFileSync(path, "utf8").includes("guardedDeleteWip")).map((path) => basename(path))).toEqual(["change-resume.ts"]);
		expect(readFileSync(others.find((path) => basename(path) === "change-resume.ts") as string, "utf8")).not.toContain("guardedPush(");
		const ledgerUsers = others.filter((path) => /ledger(Fetch|Push|Delete)/.test(readFileSync(path, "utf8")));
		// src/ledger/sync.ts is admitted by name; it lands with the ledger module.
		const relative = (paths: string[]) => paths.map((path) => path.slice(SRC_DIR.length)).filter((path) => path !== "ledger/sync.ts");
		expect(relative(ledgerUsers)).toEqual([]);
		expect(relative(importing.filter((path) => !path.includes("/src/tools/")))).toEqual([]);
	});

	test("Refspec from the fix branch", async () => {
		const h = await toolHarness({ config: "integrationBranch: main\ntestCommand: \"true\"\n", branch: "fix/typo" });
		await writeIn(h.root, "README.md", "fixed\n");
		commitAll(h.root, "Fix a typo");
		const out = await h.call("fix_ship");
		expect(out.isError, textOf(out)).toBeFalsy();
		expect(h.gitCalls.filter((args) => args[0] === "push")).toEqual([["push", "--", "origin", "HEAD:refs/heads/fix/typo"]]);
	});
});

describe("wip refspec", () => {
	test("Refspec of a wip branch", async () => {
		const h = await parkHarness();
		await writeIn(h.lanes.U2.path, "src/u2.ts", "u2\n");
		const out = await h.park();
		expect(out.isError, textOf(out)).toBeFalsy();
		const pushes = h.gitCalls.filter((args) => args[0] === "push");
		expect(pushes).toEqual([["push", "--", "origin", `HEAD:refs/heads/${BRANCH}--wip-U2`]]);
		expect(originRefs(h.origin)).toContain(`refs/heads/${BRANCH}--wip-U2`);
	});
});

describe("guardedDeleteWip", () => {
	const B = "livespec/x--wip-U2";
	const DECOY = "refs/heads/pre/refs/heads/livespec/x--wip-U2";

	async function pushed() {
		const h = await toolHarness();
		h.git("push", "origin", `HEAD:refs/heads/${B}`);
		const head = h.git("rev-parse", "HEAD");
		return { h, head };
	}
	function recording(inner: GitExec = defaultGitExec): { exec: GitExec; calls: string[][] } {
		const calls: string[][] = [];
		return { calls, exec: (args, opts) => (calls.push(args), inner(args, opts)) };
	}
	function newCommit(h: Awaited<ReturnType<typeof toolHarness>>, head: string): string {
		return h.git("commit-tree", "-p", head, "-m", "moved", `${head}^{tree}`);
	}

	test("deletes the ref at the recorded head", async () => {
		const { h, head } = await pushed();
		expect(await guardedDeleteWip(defaultGitExec, h.root, B, head)).toBe("deleted");
		expect(originRefs(h.origin)).not.toContain(`refs/heads/${B}`);
	});

	test("returns gone when the ref is already absent", async () => {
		const { h, head } = await pushed();
		await guardedDeleteWip(defaultGitExec, h.root, B, head);
		expect(await guardedDeleteWip(defaultGitExec, h.root, B, head)).toBe("gone");
	});

	test("returns moved and keeps the ref when its head differs", async () => {
		const { h, head } = await pushed();
		const c = newCommit(h, head);
		h.git("push", "origin", `${c}:refs/heads/${B}`);
		expect(await guardedDeleteWip(defaultGitExec, h.root, B, head)).toBe("moved");
		expect(originRefs(h.origin)).toContain(`${c} refs/heads/${B}`);
	});

	test("stale lease is reported as moved", async () => {
		const { h, head } = await pushed();
		const c = newCommit(h, head);
		h.git("push", "origin", `${c}:refs/heads/${B}`);
		let first = true;
		const exec: GitExec = async (args, opts) => {
			if (first && args[0] === "ls-remote") {
				first = false;
				return { stdout: `${head}\trefs/heads/${B}\n`, stderr: "", code: 0 };
			}
			return defaultGitExec(args, opts);
		};
		expect(await guardedDeleteWip(exec, h.root, B, head)).toBe("moved");
		expect(originRefs(h.origin)).toContain(`${c} refs/heads/${B}`);
	});

	function failingPush(lsRemote: string[]): GitExec {
		const reads = [...lsRemote];
		return async (args) => {
			if (args[0] === "push") return { stdout: "", stderr: "rejected", code: 1 };
			const out = reads.shift();
			return out === undefined ? { stdout: "", stderr: "", code: 2 } : { stdout: out, stderr: "", code: 0 };
		};
	}

	test("a failed push whose re-read shows the ref absent returns gone", async () => {
		const { h, head } = await pushed();
		const exec = failingPush([`${head}\trefs/heads/${B}\n`]);
		expect(await guardedDeleteWip(exec, h.root, B, head)).toBe("gone");
	});

	test("a failed push whose re-read still shows the head throws GitError", async () => {
		const { h, head } = await pushed();
		const line = `${head}\trefs/heads/${B}\n`;
		await expect(guardedDeleteWip(failingPush([line, line]), h.root, B, head)).rejects.toBeInstanceOf(GitError);
	});

	test("refuses a non-wip branch", async () => {
		const { h, head } = await pushed();
		const { exec, calls } = recording();
		for (const name of ["livespec/x", "main", "-x--wip-U2"]) {
			await expect(guardedDeleteWip(exec, h.root, name, head)).rejects.toBeInstanceOf(GitError);
		}
		expect(calls).toEqual([]);
	});

	test("ignores a suffix ref", async () => {
		const { h, head } = await pushed();
		const c = newCommit(h, head);
		h.git("push", "origin", `${c}:${DECOY}`);
		expect(await guardedDeleteWip(defaultGitExec, h.root, B, head)).toBe("deleted");
		expect(await guardedDeleteWip(defaultGitExec, h.root, B, head)).toBe("gone");
		expect(originRefs(h.origin)).toContain(`${c} ${DECOY}`);
	});

	test("unreachable remote throws", async () => {
		const { h, head } = await pushed();
		h.git("remote", "set-url", "origin", "/nonexistent");
		await expect(guardedDeleteWip(defaultGitExec, h.root, B, head)).rejects.toBeInstanceOf(GitError);
	});

	test("Delete of a wip branch", async () => {
		const { h, head } = await pushed();
		const { exec, calls } = recording();
		expect(await guardedDeleteWip(exec, h.root, B, head)).toBe("deleted");
		expect(calls.filter((a) => a[0] === "push")).toEqual([["push", `--force-with-lease=refs/heads/${B}:${head}`, "--", "origin", `:refs/heads/${B}`]]);
	});
});

describe("guardedPush", () => {
	test("pushes the refspec to the remote", async () => {
		const h = await toolHarness();
		h.git("commit", "-q", "--allow-empty", "-m", "next");
		await guardedPush(defaultGitExec, h.root, "origin", "HEAD:refs/heads/main");
		expect(originRefs(h.origin)).toContain(`${h.git("rev-parse", "HEAD")} refs/heads/main`);
	});

	test("a failed push throws GitError", async () => {
		const h = await toolHarness();
		const before = originRefs(h.origin);
		await expect(guardedPush(defaultGitExec, h.root, "origin", "refs/heads/missing:refs/heads/main")).rejects.toBeInstanceOf(GitError);
		expect(originRefs(h.origin)).toBe(before);
		execFileSync("git", ["status"], { cwd: h.root });
	});
});

describe("ledger operations", () => {
	function fake(code = 0, stderr = "", stdout = ""): { exec: GitExec; calls: string[][] } {
		const calls: string[][] = [];
		return { calls, exec: async (args) => (calls.push(args), { stdout, stderr, code }) };
	}

	test("Ledger push refspec", async () => {
		const { exec, calls } = fake();
		expect(await ledgerPush(exec, "/r", 59, "t")).toBe("pushed");
		expect(calls).toEqual([["push", "--", "origin", "t:refs/livespec/59"]]);
	});

	test("ledgerPush reports a non-fast-forward as rejected and throws on other failures", async () => {
		for (const stderr of ["! [rejected] x", "hint: fetch first", "non-fast-forward"]) {
			expect(await ledgerPush(fake(1, stderr).exec, "/r", 59, "t")).toBe("rejected");
		}
		await expect(ledgerPush(fake(128, "fatal: unreachable").exec, "/r", 59, "t")).rejects.toBeInstanceOf(GitError);
	});

	test("ledgerFetch asks ls-remote first, then fetches", async () => {
		const { exec, calls } = fake(0, "", "t\trefs/livespec/59\n");
		expect(await ledgerFetch(exec, "/r", 59)).toBe("fetched");
		expect(calls).toEqual([
			["ls-remote", "--exit-code", "--", "origin", "refs/livespec/59"],
			["fetch", "--", "origin", "+refs/livespec/59:refs/livespec-origin/59"],
		]);
	});

	test("ledgerFetch returns absent when ls-remote exits 2", async () => {
		const { exec, calls } = fake(2);
		expect(await ledgerFetch(exec, "/r", 59)).toBe("absent");
		expect(calls).toHaveLength(1);
	});

	test("ledgerDelete uses a lease on the synced tip", async () => {
		const { exec, calls } = fake(0, "", "t\trefs/livespec/59\n");
		expect(await ledgerDelete(exec, "/r", 59, "t")).toBe("deleted");
		expect(calls.filter((a) => a[0] === "push")).toEqual([["push", "--force-with-lease=refs/livespec/59:t", "--", "origin", ":refs/livespec/59"]]);
	});

	test("ledgerDelete reports gone and moved", async () => {
		expect(await ledgerDelete(fake(2).exec, "/r", 59, "t")).toBe("gone");
		expect(await ledgerDelete(fake(0, "", "other\trefs/livespec/59\n").exec, "/r", 59, "t")).toBe("moved");
	});

	test("Ledger operations refuse a bad issue number", async () => {
		const { exec, calls } = fake();
		for (const n of [0, -1, 1.5, "59 --force"] as unknown as number[]) {
			await expect(ledgerFetch(exec, "/r", n)).rejects.toBeInstanceOf(GitError);
			await expect(ledgerPush(exec, "/r", n, "t")).rejects.toBeInstanceOf(GitError);
			await expect(ledgerDelete(exec, "/r", n, "t")).rejects.toBeInstanceOf(GitError);
		}
		expect(calls).toEqual([]);
	});
});
