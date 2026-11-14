import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultGitExec } from "../../src/engine/git-exec.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ls-gitexec-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("defaultGitExec", () => {
	test("resolves with a non-zero code instead of rejecting", async () => {
		const result = await defaultGitExec(["rev-parse", "--git-dir"], { cwd: dir });
		expect(result.code).not.toBe(0);
		expect(result.code).not.toBeNull();
	});

	test("per-call env reaches git", async () => {
		const result = await defaultGitExec(["var", "GIT_AUTHOR_IDENT"], {
			cwd: dir,
			env: { GIT_AUTHOR_NAME: "probe", GIT_AUTHOR_EMAIL: "p@example.test" },
		});
		expect(result.stdout).toContain("probe");
	});

	test("env does not leak into process.env", async () => {
		await defaultGitExec(["--version"], { cwd: dir, env: { LS_PROBE_VAR: "x" } });
		expect(process.env.LS_PROBE_VAR).toBeUndefined();
	});
});
