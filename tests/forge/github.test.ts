import { afterEach, describe, expect, it } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import { GitHubForge } from "../../src/forge/github.ts";
import { runContract } from "./contract.ts";
import { tick } from "./fake-gh/state.ts";
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

	describe("hostname", () => {
		it("passes --hostname to gh auth status and every gh api call when set", async () => {
			const w = new GitHubWorld({ hostname: "ghe.example.com" });
			worlds.push(w);
			await w.forge.whoami();
			await w.forge.listLabels();

			const argv = w.argvLog();
			expect(argv.length).toBeGreaterThanOrEqual(3);
			expect(argv[0]).toEqual(["auth", "status", "--hostname", "ghe.example.com"]);
			for (const call of argv.slice(1)) {
				expect(call[0]).toBe("api");
				expect(call.slice(call.indexOf("--hostname"), call.indexOf("--hostname") + 2)).toEqual(["--hostname", "ghe.example.com"]);
			}
		});

		it("passes no --hostname when unset", async () => {
			const w = make();
			await w.forge.whoami();
			expect(w.argvLog().length).toBeGreaterThanOrEqual(2);
			expect(w.argvLog().flat()).not.toContain("--hostname");
		});
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

	it("getChecks sees a failure on the 101st commit status (per_page boundary)", async () => {
		const w = make();
		// seedStatus alternates endpoints, so 201 entries put 101 on the statuses endpoint.
		for (let i = 0; i < 201; i++) await w.seedStatus("sha2", { name: `c${i}`, state: i === 200 ? "failure" : "success" });
		const summary = await w.forge.getChecks("sha2");
		expect(summary.state).toBe("failure");
		expect(summary.checks).toHaveLength(201);
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

	it("an evicted snapshot still conflicts by version, falls back to body and issues no PATCH", async () => {
		const w = make();
		const a = await w.seedIssue({ title: "A", body: "original" });
		const read = await w.forge.getIssue(a);
		for (let i = 0; i < 300; i++) await w.seedIssue({ labels: ["bulk"], body: `b${i}` });
		expect(await w.forge.searchIssues({ labels: ["bulk"] })).toHaveLength(300);
		w.store.update((d) => {
			d.issues[String(a)].title = "A2";
			d.issues[String(a)].body = "edited";
		});

		const result = await w.forge.updateIssueBody(a, "mine", read.version);

		expect(result).toMatchObject({ status: "conflict", changed: ["body"] });
		expect(w.calls().filter((c) => c.method === "PATCH")).toEqual([]);
	});

	it("a recent snapshot still names the changed fields after many other reads", async () => {
		const w = make();
		const a = await w.seedIssue({ title: "A", body: "original" });
		for (let i = 0; i < 20; i++) await w.seedIssue({ labels: ["bulk"] });
		await w.forge.searchIssues({ labels: ["bulk"] });
		const read = await w.forge.getIssue(a);
		w.store.update((d) => {
			d.issues[String(a)].title = "A2";
			d.issues[String(a)].updatedAt = tick(d);
		});
		const result = await w.forge.updateIssueBody(a, "mine", read.version);
		expect(result).toMatchObject({ status: "conflict", changed: ["title"] });
	});

	it("an issue and a pull request with the same number do not share snapshots", async () => {
		const w = make();
		const n = await w.seedIssue({ title: "T1", body: "same" });
		const p = await w.seedPullRequest({ head: "feat/x", title: "T2", body: "same" });
		w.store.update((d) => {
			const pull = d.pulls[String(p)];
			delete d.pulls[String(p)];
			pull.number = n;
			pull.updatedAt = d.issues[String(n)].updatedAt;
			d.pulls[String(n)] = pull;
		});
		const issue = await w.forge.getIssue(n);
		const pull = await w.forge.getPullRequest(n);
		expect(pull.version).toBe(issue.version);
		w.store.update((d) => {
			d.issues[String(n)].title = "T2";
			d.issues[String(n)].body = "edited";
		});

		const result = await w.forge.updateIssueBody(n, "mine", issue.version);

		expect(result).toMatchObject({ status: "conflict", changed: ["title", "body"] });
	});

	it("mutating a returned entity does not corrupt conflict field naming", async () => {
		const w = make();
		const n = await w.seedIssue({ title: "T", body: "b", labels: ["a"] });
		const read = await w.forge.getIssue(n);
		read.title = "T2";
		read.body = "b2";
		read.labels.splice(0, 1, "z");
		w.store.update((d) => {
			const issue = d.issues[String(n)];
			issue.title = "T2";
			issue.body = "b2";
			issue.labels = ["z"];
			issue.updatedAt = tick(d);
			d.labels.push("z");
		});

		const result = await w.forge.updateIssueBody(n, "mine", read.version);

		expect(result).toMatchObject({ status: "conflict", changed: ["title", "body", "labels"] });
	});

	it("the login is not cached: a changed login is re-checked before the next comment edit", async () => {
		const w = make();
		const n = await w.seedIssue();
		const created = await w.forge.createComment(n, writeMarked("receipt", "u1", { v: 1 }));
		await w.forge.updateComment(created.id, writeMarked("receipt", "u1", { v: 2 }), created.version);
		await w.forge.whoami();
		w.store.update((d) => {
			d.login = "someone-else";
		});
		w.store.update((d) => {
			d.calls = [];
		});

		await expect(w.forge.updateComment(created.id, writeMarked("receipt", "u1", { v: 3 }), created.version)).rejects.toBeInstanceOf(ForgeError);
		expect(w.calls().filter((c) => c.method === "PATCH")).toEqual([]);
	});

	it("a comment that lost its marker after the caller read it is refused without a PATCH", async () => {
		const w = make();
		const n = await w.seedIssue();
		const created = await w.forge.createComment(n, writeMarked("receipt", "u1", { v: 1 }));
		const [read] = await w.forge.listComments(n);
		w.store.update((d) => {
			d.comments[created.id].body = "plain text now";
		});

		await expect(w.forge.updateComment(created.id, writeMarked("receipt", "u1", { v: 2 }), read.version)).rejects.toBeInstanceOf(ForgeError);
		expect(w.calls().filter((c) => c.method === "PATCH")).toEqual([]);
		expect(await w.commentBodyOf(created.id)).toBe("plain text now");
	});

	it("a successful pull request body write reports check best-effort", async () => {
		const w = make();
		const n = await w.seedPullRequest({ head: "feat/x", body: "original" });
		const read = await w.forge.getPullRequest(n);

		const result = await w.forge.updatePullRequest(n, { body: "mine" }, read.version);

		expect(result).toMatchObject({ status: "written", check: "best-effort" });
		expect(w.calls().filter((c) => c.method === "PATCH")).toHaveLength(1);
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
