import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultGitExec } from "../../src/engine/git-exec.ts";
import { GitError } from "../../src/engine/git.ts";
import { guardedPush } from "../../src/guard/push.ts";
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
		const allowed = new Set(["change-ship.ts", "change-push.ts", "fix-ship.ts", "change-park.ts"]);
		expect(importing.map((path) => basename(path)).filter((name) => !allowed.has(name))).toEqual([]);
		expect(importing.map((path) => basename(path))).toContain("change-ship.ts");
		expect(importing.map((path) => basename(path))).toContain("change-park.ts");
		expect(importing.map((path) => basename(path))).not.toContain("change-resume.ts");
		expect(importing.every((path) => path.includes("/src/tools/"))).toBe(true);
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
