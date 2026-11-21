import { describe, expect, test } from "vitest";
import { GitError } from "../../src/engine/git.ts";
import type { Git } from "../../src/engine/git.ts";
import { ForgeError } from "../../src/forge/errors.ts";
import type { Forge } from "../../src/forge/types.ts";
import { readPullRequest } from "../../src/ship/pull-request.ts";

const header = { pr: "#41", branch: "b" } as never;
const forgeOf = (get: () => Promise<unknown>) => ({ getPullRequest: get }) as unknown as Forge;
const gitOf = (ref: () => Promise<string | undefined>) => ({ remoteRef: ref }) as unknown as Git;
const open = async () => ({ state: "open", merged: false });

describe("readPullRequest", () => {
	test("a git error reading the pushed head keeps the pull request and warns", async () => {
		const out = await readPullRequest(forgeOf(open), gitOf(async () => { throw new GitError(["rev-parse"], 128, "boom"); }), header, "b");
		expect(out.pr).toEqual({ number: 41, state: "open", merged: false });
		expect(out.warnings.join()).toContain("pushed head");
	});
	test("a forge error is a warning with no pull request", async () => {
		const out = await readPullRequest(forgeOf(async () => { throw new ForgeError({ code: "unreachable", operation: "getPullRequest", message: "down" }); }), gitOf(async () => "a"), header, "b");
		expect(out.pr).toBeUndefined();
		expect(out.warnings.join()).toContain("cannot be read");
	});
	test("a programming error is not swallowed", async () => {
		await expect(readPullRequest(forgeOf(async () => { throw new TypeError("bug"); }), gitOf(async () => "a"), header, "b")).rejects.toThrow("bug");
		await expect(readPullRequest(forgeOf(open), gitOf(async () => { throw new TypeError("bug"); }), header, "b")).rejects.toThrow("bug");
	});
});
