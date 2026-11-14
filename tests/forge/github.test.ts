import { afterEach, describe, expect, it } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import { writeMarked } from "../../src/forge/markers.ts";
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

	it("a current version issues exactly one PATCH and reports best-effort", async () => {
		const w = make();
		const n = await w.seedIssue({ body: "original" });
		const read = await w.forge.getIssue(n);

		const result = await w.forge.updateIssueBody(n, "mine", read.version);

		expect(result).toMatchObject({ status: "written", check: "best-effort" });
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
		const created = await w.forge.createComment(n, writeMarked("receipt", "u1", { v: 1 }));
		const result = await w.forge.updateComment(created.id, writeMarked("receipt", "u1", { v: 2 }), created.version);
		expect(result).toMatchObject({ status: "written", check: "best-effort" });
	});

	it("getChecks follows pagination on check runs and commit statuses", async () => {
		for (const failing of [248, 249]) {
			const w = make();
			for (let i = 0; i < 250; i++) {
				await w.seedStatus("sha1", { name: `c${i}`, state: i === failing ? "failure" : "success" });
			}
			const summary = await w.forge.getChecks("sha1");
			expect(summary.state).toBe("failure");
			expect(summary.checks).toHaveLength(250);
		}
	});

	it("getChecks sees a failure on the 101st check", async () => {
		const w = make();
		for (let i = 0; i < 101; i++) await w.seedStatus("sha2", { name: `c${i}`, state: i === 100 ? "failure" : "success" });
		const summary = await w.forge.getChecks("sha2");
		expect(summary.state).toBe("failure");
		expect(summary.checks).toHaveLength(101);
	});

	it("conflict changed fields are scoped per issue even with equal timestamp and body", async () => {
		const w = make();
		const a = await w.seedIssue({ title: "A", body: "same" });
		const b = await w.seedIssue({ title: "B", body: "same" });
		w.store.update((d) => {
			d.issues[String(b)].updatedAt = d.issues[String(a)].updatedAt;
		});
		const readA = await w.forge.getIssue(a);
		await w.forge.getIssue(b);
		await w.editBodyBehindBack(a, "edited");

		const result = await w.forge.updateIssueBody(a, "mine", readA.version);

		expect(result).toMatchObject({ status: "conflict", changed: ["body"] });
	});

	it("a failed ownership check issues no PATCH", async () => {
		const w = make();
		const n = await w.seedIssue();
		const id = await w.postComment(n, BOT_LOGIN, "plain");
		const [c] = await w.forge.listComments(n);
		await expect(w.forge.updateComment(id, "x", c.version)).rejects.toBeInstanceOf(ForgeError);
		expect(w.calls().filter((x) => x.method === "PATCH")).toEqual([]);
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
