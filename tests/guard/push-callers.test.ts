import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultGitExec } from "../../src/engine/git-exec.ts";
import { GitError } from "../../src/engine/git.ts";
import { guardedPush } from "../../src/guard/push.ts";
import { cleanupDirs, originRefs, toolHarness } from "../tools/helpers.ts";
import { afterEach } from "vitest";

afterEach(cleanupDirs);

const TOOLS_DIR = new URL("../../src/tools/", import.meta.url).pathname;

function sourcesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		if (e.isDirectory()) return sourcesUnder(path);
		return e.name.endsWith(".ts") ? [path] : [];
	});
}

describe("command-guards", () => {
	test("No tool calls the push path", () => {
		const sources = sourcesUnder(TOOLS_DIR);
		expect(sources.length).toBeGreaterThan(0);
		const importing = sources.filter((path) => /guard\/push(\.ts)?["']/.test(readFileSync(path, "utf8")));
		const allowed = new Set(["change-ship.ts", "change-push.ts"]);
		expect(importing.map((path) => basename(path)).filter((name) => !allowed.has(name))).toEqual([]);
		expect(importing.map((path) => basename(path))).toContain("change-ship.ts");
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
