import { afterEach, describe, expect, it } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExec, type ExecFn, type ExecResult, GitHubForge, tokenEnvVar } from "../../src/forge/github.ts";
import { runContract } from "./contract.ts";
import { tick } from "./fake-gh/state.ts";
import { FAKE_GH_PATH, GitHubWorld, REPO } from "./github-world.ts";
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

	describe("error classification", () => {
		const AUTH_OK: ExecResult = { stdout: "", stderr: "", code: 0 };
		/** A forge whose `gh api` calls fail with `stderr` and exit 1; `gh auth status` succeeds. */
		const failingWith = (stderr: string): GitHubForge =>
			new GitHubForge({
				ghPath: "gh",
				repo: { owner: "a", repo: "b" },
				exec: async (_file, args) => (args[0] === "auth" ? AUTH_OK : { stdout: "", stderr, code: 1 }),
			});

		it("an internal gh failure without a network pattern is http, not unreachable", async () => {
			await expect(failingWith("gh: unexpected end of JSON input").whoami()).rejects.toMatchObject({ code: "http", operation: "whoami" });
		});

		it("a network failure is unreachable", async () => {
			await expect(failingWith("error connecting to api.github.com").whoami()).rejects.toMatchObject({ code: "unreachable" });
			await expect(failingWith("dial tcp: lookup api.github.com: no such host").whoami()).rejects.toMatchObject({ code: "unreachable" });
		});

		it("401 and 403 are auth", async () => {
			await expect(failingWith("gh: Bad credentials (HTTP 401)").whoami()).rejects.toMatchObject({ code: "auth", status: 401 });
			await expect(failingWith("gh: Resource not accessible by integration (HTTP 403)").whoami()).rejects.toMatchObject({ code: "auth", status: 403 });
		});

		it("a rate-limit 403 stays http", async () => {
			await expect(failingWith("gh: API rate limit exceeded for user ID 1. (HTTP 403)").whoami()).rejects.toMatchObject({ code: "http", status: 403 });
		});

		it("a gh call that never ends is aborted and unreachable", async () => {
			const dir = mkdtempSync(join(tmpdir(), "hang-gh-"));
			const ghPath = join(dir, "gh");
			writeFileSync(ghPath, "#!/bin/sh\nexec sleep 30\n");
			chmodSync(ghPath, 0o755);
			try {
				const forge = new GitHubForge({ ghPath, repo: { owner: "a", repo: "b" }, exec: createExec({ timeoutMs: 100 }) });
				await expect(forge.whoami()).rejects.toMatchObject({ code: "unreachable", operation: "whoami" });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
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

describe("github adapter with an account token", () => {
	const TTDUA = { login: "ttdua", token: "tok-ttdua", push: true };
	const NAICOI = { login: "naicoi92", token: "tok-naicoi92", push: true };
	const worlds: GitHubWorld[] = [];
	/** A world whose active `gh` account is naicoi92 and whose adapter carries `token`. */
	const make = (opts: { token?: string; hostname?: string; accounts?: (typeof TTDUA)[] } = {}): GitHubWorld => {
		const w = new GitHubWorld({ accounts: opts.accounts ?? [TTDUA, NAICOI], token: opts.token, hostname: opts.hostname });
		w.store.update((d) => {
			d.login = NAICOI.login;
		});
		worlds.push(w);
		return w;
	};
	afterEach(async () => {
		for (const w of worlds.splice(0)) await w.dispose();
	});

	it("Account token used", async () => {
		const w = make({ token: TTDUA.token });

		expect(await w.forge.whoami()).toEqual({ login: "ttdua" });
		const issue = await w.forge.createIssue({ title: "t", body: "b", labels: [] });

		expect(issue.author).toBe("ttdua");
		expect(w.envLog().length).toBeGreaterThanOrEqual(3);
		for (const env of w.envLog()) expect(env).toEqual({ GH_TOKEN: TTDUA.token });
	});

	it("Enterprise host token", async () => {
		const w = make({ token: TTDUA.token, hostname: "ghe.example.org" });

		expect(await w.forge.whoami()).toEqual({ login: "ttdua" });

		expect(w.envLog().length).toBeGreaterThanOrEqual(2);
		for (const env of w.envLog()) expect(env).toEqual({ GH_ENTERPRISE_TOKEN: TTDUA.token });
		for (const argv of w.argvLog()) expect(argv.slice(argv.indexOf("--hostname"), argv.indexOf("--hostname") + 2)).toEqual(["--hostname", "ghe.example.org"]);
	});

	it("Token not in arguments", async () => {
		const w = make({ token: TTDUA.token });
		await w.forge.whoami();
		const n = await w.forge.createIssue({ title: "t", body: "b", labels: ["x"] });
		await w.forge.createComment(n.number, "c");

		expect(w.argvLog().length).toBeGreaterThanOrEqual(4);
		for (const arg of w.argvLog().flat()) expect(arg).not.toContain(TTDUA.token);
	});

	it("No token given", async () => {
		const envs: (Record<string, string> | undefined)[] = [];
		const w = make();
		const recording: ExecFn = (file, args, input, env) => {
			envs.push(env);
			return w.exec(file, args, input, env);
		};
		const forge = new GitHubForge({ ghPath: FAKE_GH_PATH, repo: REPO, exec: recording });

		expect(await forge.whoami()).toEqual({ login: "naicoi92" });
		expect(envs.length).toBeGreaterThanOrEqual(2);
		for (const env of envs) expect(env).toBeUndefined();
	});

	it("token with leading dash never reaches argv", async () => {
		const odd = { login: "odd", token: "--hostname=evil.example.org\n-x", push: true };
		const w = make({ token: odd.token, accounts: [odd, NAICOI] });

		expect(await w.forge.whoami()).toEqual({ login: "odd" });

		for (const env of w.envLog()) expect(env).toEqual({ GH_TOKEN: odd.token });
		for (const arg of w.argvLog().flat()) {
			expect(arg).not.toContain("evil.example.org");
			expect(arg).not.toContain("\n");
		}
	});

	it("ambient gh token variables never reach the fake gh", async () => {
		const AMBIENT = "ambient-sentinel";
		const saved = { GH_TOKEN: process.env.GH_TOKEN, GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN };
		process.env.GH_TOKEN = `${AMBIENT}-gh`;
		process.env.GH_ENTERPRISE_TOKEN = `${AMBIENT}-ghe`;
		try {
			const w = new GitHubWorld();
			worlds.push(w);

			expect(await w.forge.whoami()).toEqual({ login: BOT_LOGIN });
			await w.forge.createIssue({ title: "t", body: "b", labels: [] });

			expect(readFileSync(w.store.path, "utf8")).not.toContain(AMBIENT);
			for (const env of w.envLog()) expect(env).toEqual({});
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("tokenEnvVar maps hosts", () => {
		expect(tokenEnvVar(undefined)).toBe("GH_TOKEN");
		expect(tokenEnvVar("github.com")).toBe("GH_TOKEN");
		expect(tokenEnvVar("GitHub.com")).toBe("GH_TOKEN");
		expect(tokenEnvVar("acme.ghe.com")).toBe("GH_TOKEN");
		expect(tokenEnvVar("ghe.example.org")).toBe("GH_ENTERPRISE_TOKEN");
		expect(tokenEnvVar("ghe.example.org:8443")).toBe("GH_ENTERPRISE_TOKEN");
		expect(tokenEnvVar("ghe.com.example.org")).toBe("GH_ENTERPRISE_TOKEN");
	});
});
