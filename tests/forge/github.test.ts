import { afterEach, describe, expect, it } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import { GitHubForge } from "../../src/forge/github.ts";
import { runContract } from "./contract.ts";
import { GitHubWorld } from "./github-world.ts";
import { BOT_LOGIN } from "./world.ts";

runContract("github", () => new GitHubWorld());

describe("github adapter", () => {
	const worlds: GitHubWorld[] = [];
	const make = (): GitHubWorld => {
		const w = new GitHubWorld();
		worlds.push(w);
		return w;
	};
	afterEach(async () => {
		for (const w of worlds.splice(0)) await w.dispose();
	});

	it("gh auth status failure throws auth naming the operation", async () => {
		const w = make();
		const n = await w.seedIssue();
		await w.logout();

		const error = await w.forge.getIssue(n).then(
			() => undefined,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(ForgeError);
		expect((error as ForgeError).code).toBe("auth");
		expect((error as ForgeError).operation).toBe("getIssue");
		expect((error as ForgeError).message).toContain("getIssue");
		expect(w.calls()).toEqual([]);
	});

	it("whoami reads the login from gh api user", async () => {
		const w = make();
		expect(await w.forge.whoami()).toEqual({ login: BOT_LOGIN });
		expect(w.calls().map((c) => `${c.method} ${c.route}`)).toEqual(["GET user"]);
	});

	it("no PATCH is issued when the issue changed since the read", async () => {
		const w = make();
		const n = await w.seedIssue({ body: "original" });
		const read = await w.forge.getIssue(n);
		await w.editBodyBehindBack(n, "edited elsewhere");

		const result = await w.forge.updateIssueBody(n, "mine", read.version);

		expect(result.status).toBe("conflict");
		expect(w.calls().filter((c) => c.method === "PATCH")).toEqual([]);
	});

	it("a current version issues exactly one PATCH and reports strict", async () => {
		const w = make();
		const n = await w.seedIssue({ body: "original" });
		const read = await w.forge.getIssue(n);

		const result = await w.forge.updateIssueBody(n, "mine", read.version);

		expect(result).toMatchObject({ status: "written", check: "strict" });
		expect(w.calls().filter((c) => c.method === "PATCH")).toHaveLength(1);
	});

	it("no PATCH is issued for a stale pull request body", async () => {
		const w = make();
		const n = await w.seedPullRequest({ head: "feat/x", body: "original" });
		const read = await w.forge.getPullRequest(n);
		await w.editPullRequestBodyBehindBack(n, "edited elsewhere");

		const result = await w.forge.updatePullRequest(n, { body: "mine" }, read.version);

		expect(result.status).toBe("conflict");
		expect(w.calls().filter((c) => c.method === "PATCH")).toEqual([]);
	});

	it("comment edits report best-effort", async () => {
		const w = make();
		const n = await w.seedIssue();
		const created = await w.forge.createComment(n, "hi");
		const result = await w.forge.updateComment(created.id, "ho", created.version);
		expect(result).toMatchObject({ status: "written", check: "best-effort" });
	});

	it("a missing gh executable is unreachable", async () => {
		const forge = new GitHubForge({ ghPath: "/nonexistent/gh", repo: { owner: "a", repo: "b" } });
		await expect(forge.whoami()).rejects.toMatchObject({ code: "unreachable", operation: "whoami" });
	});

	it("a non-2xx answer throws http with the status", async () => {
		const w = make();
		const error = await w.forge.getIssue(999).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toMatchObject({ code: "http", status: 404, operation: "getIssue" });
	});
});
