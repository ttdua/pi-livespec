import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import { GiteaForge } from "../../src/forge/gitea.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import { runContract } from "./contract.ts";
import { FAKE_TOKEN } from "./fake-gitea.ts";
import { GiteaWorld } from "./gitea-world.ts";
import { OTHER_LOGIN } from "./world.ts";

const spawned = vi.hoisted(() => ({ calls: vi.fn() }));
vi.mock("node:child_process", () => ({
	spawn: spawned.calls,
	spawnSync: spawned.calls,
	exec: spawned.calls,
	execSync: spawned.calls,
	execFile: spawned.calls,
	execFileSync: spawned.calls,
	fork: spawned.calls,
}));

runContract("gitea-cv", () => GiteaWorld.create({ withContentVersion: true }));
runContract("gitea-no-cv", () => GiteaWorld.create({ withContentVersion: false }));

const COMMENT = { id: 1, body: "x", user: { login: "u" }, updated_at: "2026-01-01T00:00:00Z" };
const ISSUE = { number: 1, title: "t", body: "b", state: "open", updated_at: "2026-01-01T00:00:00Z", labels: [] };

describe("gitea adapter", () => {
	const worlds: GiteaWorld[] = [];

	async function world(withContentVersion = true): Promise<GiteaWorld> {
		const w = await GiteaWorld.create({ withContentVersion });
		worlds.push(w);
		return w;
	}

	afterEach(async () => {
		for (const w of worlds.splice(0)) await w.dispose();
		spawned.calls.mockClear();
	});

	describe("token", () => {
		it("comes from GITEA_TOKEN", async () => {
			const w = await world();
			const forge = new GiteaForge({ baseUrl: w.fake.url, owner: "o", repo: "r", env: { GITEA_TOKEN: FAKE_TOKEN }, teaConfigPath: "/nonexistent" });
			await forge.whoami();
			expect(w.fake.calls[0].authorization).toBe(`token ${FAKE_TOKEN}`);
		});

		it("comes from the tea config login for the host, without spawning tea", async () => {
			const w = await world();
			const dir = await mkdtemp(join(tmpdir(), "tea-"));
			const teaConfigPath = join(dir, "config.yml");
			await writeFile(
				teaConfigPath,
				`logins:\n  - name: other\n    url: https://gitea.example.org\n    token: wrong\n  - name: local\n    url: ${w.fake.url}\n    token: ${FAKE_TOKEN}\n    user: bot\n`,
			);
			const forge = new GiteaForge({ baseUrl: w.fake.url, owner: "o", repo: "r", env: {}, teaConfigPath });

			await expect(forge.whoami()).resolves.toEqual({ login: "livespec-bot" });

			expect(w.fake.calls[0].authorization).toBe(`token ${FAKE_TOKEN}`);
			expect(spawned.calls).not.toHaveBeenCalled();
		});

		it("is an auth error naming the operation when none is found", async () => {
			const w = await world();
			const n = await w.seedIssue();
			const forge = new GiteaForge({ baseUrl: w.fake.url, owner: "o", repo: "r", env: {}, teaConfigPath: "/nonexistent/tea.yml" });

			const error = await forge.getIssue(n).then(
				() => undefined,
				(e: unknown) => e,
			);

			expect(error).toBeInstanceOf(ForgeError);
			expect(error).toMatchObject({ code: "auth", operation: "getIssue" });
			expect(w.fake.calls).toEqual([]);
		});

		it("a rejected token is an auth error with its status", async () => {
			const w = await world();
			const forge = new GiteaForge({ baseUrl: w.fake.url, owner: "o", repo: "r", env: { GITEA_TOKEN: "bad" }, teaConfigPath: "/nonexistent" });
			await expect(forge.whoami()).rejects.toMatchObject({ code: "auth", status: 401, operation: "whoami" });
		});
	});

	describe("with content_version", () => {
		it("versions are cv:<n>", async () => {
			const w = await world();
			const n = await w.seedIssue();
			expect((await w.forge.getIssue(n)).version).toMatch(/^cv:\d+$/);
		});

		it("stale version: 409 becomes conflict and the body is unchanged", async () => {
			const w = await world();
			const n = await w.seedIssue({ body: "original" });
			const read = await w.forge.getIssue(n);
			await w.editBodyBehindBack(n, "edited elsewhere");

			const result = await w.forge.updateIssueBody(n, "mine", read.version);

			expect(result.status).toBe("conflict");
			expect(await w.bodyOf(n)).toBe("edited elsewhere");
			const patch = w.fake.calls.find((c) => c.method === "PATCH");
			expect(patch?.body).toMatchObject({ body: "mine", content_version: 1 });
		});

		it("current version: written with strict check", async () => {
			const w = await world();
			const n = await w.seedIssue({ body: "original" });
			const read = await w.forge.getIssue(n);

			const result = await w.forge.updateIssueBody(n, "mine", read.version);

			expect(result).toMatchObject({ status: "written", check: "strict" });
		});
	});

	describe("without content_version (older server)", () => {
		it("versions are rc:<updatedAt>:<hash> and no content_version is sent", async () => {
			const w = await world(false);
			const n = await w.seedIssue({ body: "original" });
			const read = await w.forge.getIssue(n);
			expect(read.version).toMatch(/^rc:/);

			const result = await w.forge.updateIssueBody(n, "mine", read.version);

			expect(result).toMatchObject({ status: "written", check: "best-effort" });
			const patch = w.fake.calls.find((c) => c.method === "PATCH");
			expect(patch?.body).not.toHaveProperty("content_version");
		});

		it("a body that changed since the read is a conflict and nothing is written", async () => {
			const w = await world(false);
			const n = await w.seedIssue({ body: "original" });
			const read = await w.forge.getIssue(n);
			await w.editBodyBehindBack(n, "edited elsewhere");

			const result = await w.forge.updateIssueBody(n, "mine", read.version);

			expect(result).toMatchObject({ status: "conflict", changed: ["body"] });
			expect(await w.bodyOf(n)).toBe("edited elsewhere");
			expect(w.fake.calls.some((c) => c.method === "PATCH")).toBe(false);
		});

		it("pull request body edits use the same re-read check", async () => {
			const w = await world(false);
			const n = await w.seedPullRequest({ head: "feat/x", body: "original" });
			const read = await w.forge.getPullRequest(n);
			await w.editPullRequestBodyBehindBack(n, "edited elsewhere");

			expect((await w.forge.updatePullRequest(n, { body: "mine" }, read.version)).status).toBe("conflict");
		});
	});
	describe("comment edits are own-marker only", () => {
		it("a marked comment by another account is refused with no PATCH sent", async () => {
			const w = await world();
			const n = await w.seedIssue();
			await w.postComment(n, OTHER_LOGIN, writeMarked("decision", "d1", { choice: "x" }));
			const [foreign] = await w.forge.listComments(n);
			w.fake.calls.length = 0;

			await expect(w.forge.updateComment(foreign.id, writeMarked("decision", "d1", { choice: "y" }), foreign.version)).rejects.toMatchObject({ code: "unsupported", operation: "updateComment" });

			expect(w.fake.calls.some((c) => c.method === "PATCH")).toBe(false);
		});

		it("an unmarked own comment is refused with no PATCH sent", async () => {
			const w = await world();
			const n = await w.seedIssue();
			const created = await w.forge.createComment(n, "plain remark");
			w.fake.calls.length = 0;

			await expect(w.forge.updateComment(created.id, "changed", created.version)).rejects.toBeInstanceOf(ForgeError);

			expect(w.fake.calls.some((c) => c.method === "PATCH")).toBe(false);
		});

		it("a marked own comment is edited with one PATCH", async () => {
			const w = await world();
			const n = await w.seedIssue();
			const created = await w.forge.createComment(n, writeMarked("receipt", "u1", { v: 1 }));
			w.fake.calls.length = 0;
			const edited = writeMarked("receipt", "u1", { v: 2 });

			const result = await w.forge.updateComment(created.id, edited, created.version);

			expect(result).toMatchObject({ status: "written", check: "best-effort", item: { body: edited } });
			expect(w.fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
			expect(await w.commentBodyOf(created.id)).toBe(edited);
		});
	});

	it("a marker removed behind the back after a read is refused with a fresh GET and no PATCH", async () => {
		const w = await world();
		const n = await w.seedIssue();
		const created = await w.forge.createComment(n, writeMarked("receipt", "u1", { v: 1 }));
		const [read] = await w.forge.listComments(n);
		w.fake.editComment(Number(created.id), "marker stripped");
		w.fake.calls.length = 0;

		await expect(w.forge.updateComment(read.id, writeMarked("receipt", "u1", { v: 2 }), read.version)).rejects.toMatchObject({ code: "unsupported", operation: "updateComment" });

		expect(w.fake.calls.some((c) => c.method === "GET" && c.path.includes(`/issues/comments/${created.id}`))).toBe(true);
		expect(w.fake.calls.some((c) => c.method === "PATCH")).toBe(false);
		expect(await w.commentBodyOf(created.id)).toBe("marker stripped");
	});

	describe("pagination", () => {
		it("getChecks reads every page of the commit status", async () => {
			const w = await world();
			for (let i = 0; i < 50; i++) await w.seedStatus("sha1", { name: `ok-${i}`, state: "success" });
			await w.seedStatus("sha1", { name: "late", state: "failure" });

			const summary = await w.forge.getChecks("sha1");

			expect(summary.state).toBe("failure");
			expect(summary.checks).toHaveLength(51);
			expect(summary.checks.map((c) => c.name)).toContain("late");
		});

		it("listReviews reads every page", async () => {
			const w = await world();
			const pr = await w.seedPullRequest({ head: "feat/x" });
			for (let i = 0; i < 55; i++) await w.seedReview(pr, { author: "a", state: "commented", body: `r${i}` });

			expect(await w.forge.listReviews(pr)).toHaveLength(55);
		});

		it("a review with 50 or more comments terminates and returns all of them", { timeout: 5000 }, async () => {
			const w = await world();
			const pr = await w.seedPullRequest({ head: "feat/x" });
			const comments = Array.from({ length: 55 }, (_, i) => ({ path: "a.ts", line: i + 1, body: `c${i}` }));
			w.fake.seedReview(pr, { author: "a", event: "COMMENT", body: "", comments });

			expect(await w.forge.listReviewComments(pr)).toHaveLength(55);
		});
	});

	describe("capped page size", () => {
		it("getChecks keeps reading past a short page and sees a failure on page 2", async () => {
			const w = await GiteaWorld.create({ withContentVersion: true, maxPageSize: 30 });
			worlds.push(w);
			for (let i = 0; i < 30; i++) await w.seedStatus("sha1", { name: `ok-${i}`, state: "success" });
			await w.seedStatus("sha1", { name: "late", state: "failure" });

			const summary = await w.forge.getChecks("sha1");

			expect(summary.state).toBe("failure");
			expect(summary.checks).toHaveLength(31);
		});

		it("list endpoints return every item", async () => {
			const w = await GiteaWorld.create({ withContentVersion: true, maxPageSize: 30 });
			worlds.push(w);
			const n = await w.seedIssue();
			for (let i = 0; i < 75; i++) await w.postComment(n, OTHER_LOGIN, `c${i}`);

			expect(await w.forge.listComments(n)).toHaveLength(75);
		});

		it("an endpoint that ignores `page` terminates without duplicates", async () => {
			const forge = new GiteaForge({
				baseUrl: "http://gitea.invalid",
				owner: "o",
				repo: "r",
				env: { GITEA_TOKEN: FAKE_TOKEN },
				fetch: (async () => new Response(JSON.stringify([COMMENT]), { status: 200 })) as unknown as typeof fetch,
			});
			await expect(forge.listComments(1)).resolves.toHaveLength(1);
		});
	});

	describe("required response fields", () => {
		interface Seen {
			method: string;
			path: string;
		}
		function forgeWith(respond: (seen: Seen) => Response, seen: Seen[] = []): GiteaForge {
			return new GiteaForge({
				baseUrl: "http://gitea.invalid",
				owner: "o",
				repo: "r",
				env: { GITEA_TOKEN: FAKE_TOKEN },
				fetch: (async (url: string, init?: RequestInit) => {
					const call = { method: init?.method ?? "GET", path: new URL(url).pathname };
					seen.push(call);
					return respond(call);
				}) as unknown as typeof fetch,
			});
		}
		const reply = (value: unknown) => () => new Response(JSON.stringify(value), { status: 200 });
		const without = (base: object, key: string, value?: unknown) => ({ ...base, [key]: value });
		const bad = (operation: string) => ({ code: "http", status: 200, operation });

		it("whoami rejects {} and a message-only object", async () => {
			await expect(forgeWith(reply({})).whoami()).rejects.toMatchObject(bad("whoami"));
			await expect(forgeWith(reply({ message: "x" })).whoami()).rejects.toMatchObject(bad("whoami"));
			await expect(forgeWith(reply({ login: null })).whoami()).rejects.toMatchObject(bad("whoami"));
		});

		it("getIssue rejects {} and a message-only object", async () => {
			await expect(forgeWith(reply({})).getIssue(1)).rejects.toMatchObject(bad("getIssue"));
			await expect(forgeWith(reply({ message: "x" })).getIssue(1)).rejects.toMatchObject(bad("getIssue"));
		});

		it.each(["number", "title", "state", "updated_at", "labels"])("getIssue rejects a missing or null %s", async (key) => {
			await expect(forgeWith(reply(without(ISSUE, key))).getIssue(1)).rejects.toMatchObject(bad("getIssue"));
			await expect(forgeWith(reply(without(ISSUE, key, null))).getIssue(1)).rejects.toMatchObject(bad("getIssue"));
		});

		it("getIssue accepts a null or absent body as an empty body", async () => {
			await expect(forgeWith(reply(without(ISSUE, "body", null))).getIssue(1)).resolves.toMatchObject({ number: 1, body: "" });
			const { body: _drop, ...noBody } = ISSUE;
			await expect(forgeWith(reply(noBody)).getIssue(1)).resolves.toMatchObject({ body: "" });
		});

		it.each(["id", "body", "updated_at", "user"])("comment endpoints reject a missing %s", async (key) => {
			await expect(forgeWith(reply([without(COMMENT, key)])).listComments(1)).rejects.toMatchObject(bad("listComments"));
			await expect(forgeWith(reply(without(COMMENT, key))).createComment(1, "x")).rejects.toMatchObject(bad("createComment"));
		});

		it("a comment user without a login is rejected", async () => {
			await expect(forgeWith(reply([without(COMMENT, "user", {})])).listComments(1)).rejects.toMatchObject(bad("listComments"));
		});

		it("a commit status needs context and status", async () => {
			await expect(forgeWith(reply({ statuses: [{}] })).getChecks("sha")).rejects.toMatchObject(bad("getChecks"));
			await expect(forgeWith(reply({ statuses: [{ context: "ci" }] })).getChecks("sha")).rejects.toMatchObject(bad("getChecks"));
		});

		const PULL = { ...ISSUE, head: { ref: "h" }, base: { ref: "b" } };
		it("pull requests reject {} and a missing head, base or state", async () => {
			await expect(forgeWith(reply({})).getPullRequest(1)).rejects.toMatchObject(bad("getPullRequest"));
			for (const key of ["head", "base", "state", "number"]) {
				await expect(forgeWith(reply(without(PULL, key))).getPullRequest(1)).rejects.toMatchObject(bad("getPullRequest"));
			}
			await expect(forgeWith(reply(without(PULL, "head", {}))).getPullRequest(1)).rejects.toMatchObject(bad("getPullRequest"));
		});

		it("reviews and review comments reject entries without their required fields", async () => {
			await expect(forgeWith(reply([{}])).listReviews(1)).rejects.toMatchObject(bad("listReviews"));
			const review = { id: 7, state: "COMMENT", body: "", user: { login: "a" } };
			const respond = (seen: Seen) => new Response(JSON.stringify(seen.path.endsWith("/comments") ? [{}] : [review]), { status: 200 });
			await expect(forgeWith(respond).listReviewComments(1)).rejects.toMatchObject(bad("listReviewComments"));
		});

		it("an invalid fresh read during a body write sends no PATCH", async () => {
			const seen: Seen[] = [];
			const forge = forgeWith(reply({}), seen);

			await expect(forge.updateIssueBody(1, "mine", "rc:x:y" as never)).rejects.toMatchObject({ code: "http", operation: "updateIssueBody" });

			expect(seen.some((c) => c.method === "PATCH")).toBe(false);
		});

		it("an invalid PATCH response is not reported as written", async () => {
			const forge = forgeWith((seen) => new Response(JSON.stringify(seen.method === "PATCH" ? {} : ISSUE), { status: 200 }));
			const read = await forge.getIssue(1);

			await expect(forge.updateIssueBody(1, "mine", read.version)).rejects.toMatchObject({ code: "http", operation: "updateIssueBody" });
			await expect(forge.updateIssueBody(1, "mine", "cv:3" as never)).rejects.toMatchObject({ code: "http", operation: "updateIssueBody" });
		});
	});

	describe("pagination regressions", () => {
		const forgeFor = (page: (n: number) => unknown[]): GiteaForge =>
			new GiteaForge({
				baseUrl: "http://gitea.invalid",
				owner: "o",
				repo: "r",
				env: { GITEA_TOKEN: FAKE_TOKEN },
				fetch: (async (url: string) => new Response(JSON.stringify(page(Number(new URL(url).searchParams.get("page")))), { status: 200 })) as unknown as typeof fetch,
			});
		const comment = (id: number, body = "same") => ({ ...COMMENT, id, body });

		it("a runaway paginator hits the page cap with an http error and no partial result", async () => {
			const forge = forgeFor((n) => [comment(n)]);
			await expect(forge.listComments(1)).rejects.toMatchObject({ code: "http", operation: "listComments" });
		});

		it("entries with the same content but distinct ids are not collapsed", async () => {
			const forge = forgeFor((n) => (n === 1 ? [comment(1), comment(2), comment(3)] : []));
			expect((await forge.listComments(1)).map((c) => c.id)).toEqual(["1", "2", "3"]);
		});

		it("a page mixing old and new entries keeps every new entry", async () => {
			const pages: Record<number, unknown[]> = { 1: [comment(1), comment(2)], 2: [comment(2), comment(3), comment(4)] };
			const forge = forgeFor((n) => pages[n] ?? []);
			expect((await forge.listComments(1)).map((c) => c.id)).toEqual(["1", "2", "3", "4"]);
		});
	});

	describe("default tea config lookup", () => {
		async function layout(files: Record<string, string>): Promise<string> {
			const home = await mkdtemp(join(tmpdir(), "home-"));
			for (const [rel, text] of Object.entries(files)) {
				await mkdir(dirname(join(home, rel)), { recursive: true });
				await writeFile(join(home, rel), text);
			}
			return home;
		}
		const config = (url: string, token = FAKE_TOKEN) => `logins:\n  - name: l\n    url: ${url}\n    token: ${token}\n`;
		async function whoami(w: GiteaWorld, extra: Partial<ConstructorParameters<typeof GiteaForge>[0]>): Promise<unknown> {
			const forge = new GiteaForge({ baseUrl: w.fake.url, owner: "o", repo: "r", ...extra });
			return forge.whoami();
		}

		it("uses $XDG_CONFIG_HOME/tea/config.yml when set", async () => {
			const w = await world();
			const home = await layout({ "xdg/tea/config.yml": config(w.fake.url) });
			await expect(whoami(w, { homedir: home, platform: "linux", env: { XDG_CONFIG_HOME: join(home, "xdg") } })).resolves.toMatchObject({ login: "livespec-bot" });
		});

		it("uses Library/Application Support on macOS", async () => {
			const w = await world();
			const home = await layout({ "Library/Application Support/tea/config.yml": config(w.fake.url) });
			await expect(whoami(w, { homedir: home, platform: "darwin", env: {} })).resolves.toMatchObject({ login: "livespec-bot" });
		});

		it("uses ~/.config/tea on other platforms", async () => {
			const w = await world();
			const home = await layout({ ".config/tea/config.yml": config(w.fake.url) });
			await expect(whoami(w, { homedir: home, platform: "linux", env: {} })).resolves.toMatchObject({ login: "livespec-bot" });
		});

		it("falls back to the legacy ~/.tea/tea.yml", async () => {
			const w = await world();
			const home = await layout({ ".tea/tea.yml": config(w.fake.url) });
			await expect(whoami(w, { homedir: home, platform: "linux", env: {} })).resolves.toMatchObject({ login: "livespec-bot" });
		});

		it("a login for another host is an auth error", async () => {
			const w = await world();
			const home = await layout({ ".config/tea/config.yml": config("https://gitea.example.org") });
			await expect(whoami(w, { homedir: home, platform: "linux", env: {} })).rejects.toMatchObject({ code: "auth", operation: "whoami" });
		});

		it("GITEA_TOKEN wins over the config", async () => {
			const w = await world();
			const home = await layout({ ".config/tea/config.yml": config(w.fake.url, "wrong") });
			await expect(whoami(w, { homedir: home, platform: "linux", env: { GITEA_TOKEN: FAKE_TOKEN } })).resolves.toMatchObject({ login: "livespec-bot" });
		});
	});

	describe("response bodies fail closed", () => {
		function forgeWith(respond: () => Promise<Response>): GiteaForge {
			return new GiteaForge({
				baseUrl: "http://gitea.invalid",
				owner: "o",
				repo: "r",
				env: { GITEA_TOKEN: FAKE_TOKEN },
				fetch: (async () => respond()) as unknown as typeof fetch,
			});
		}
		const unreadable = async () => {
			const response = new Response("{}", { status: 200 });
			response.text = () => Promise.reject(new Error("socket hang up"));
			return response;
		};
		const json = (text: string, status = 200) => async () => new Response(status === 204 ? null : text, { status });

		it("an unreadable body is unreachable and names the operation", async () => {
			await expect(forgeWith(unreadable).getIssue(1)).rejects.toMatchObject({ code: "unreachable", operation: "getIssue" });
			await expect(forgeWith(unreadable).listComments(1)).rejects.toMatchObject({ code: "unreachable", operation: "listComments" });
		});

		it("malformed JSON on success is an http error with status", async () => {
			await expect(forgeWith(json("{oops")).getIssue(1)).rejects.toMatchObject({ code: "http", status: 200, operation: "getIssue" });
		});

		it("a list endpoint that does not return an array is an http error", async () => {
			await expect(forgeWith(json('{"message":"x"}')).listComments(1)).rejects.toMatchObject({ code: "http", operation: "listComments" });
			await expect(forgeWith(json("")).searchIssues({})).rejects.toMatchObject({ code: "http", operation: "searchIssues" });
		});

		it("an object endpoint that returns a non-object is an http error", async () => {
			await expect(forgeWith(json("[]")).getIssue(1)).rejects.toMatchObject({ code: "http", operation: "getIssue" });
		});

		it("null or scalar list entries are http errors, not TypeErrors", async () => {
			await expect(forgeWith(json("[null]")).listComments(1)).rejects.toMatchObject({ code: "http", status: 200, operation: "listComments" });
			await expect(forgeWith(json("[1]")).searchIssues({})).rejects.toMatchObject({ code: "http", operation: "searchIssues" });
			await expect(forgeWith(json('{"statuses":[null]}')).getChecks("sha")).rejects.toMatchObject({ code: "http", status: 200, operation: "getChecks" });
			await expect(forgeWith(json('{"statuses":["x"]}')).getChecks("sha")).rejects.toMatchObject({ code: "http", operation: "getChecks" });
		});

		it("wrong-typed nested fields are http errors", async () => {
			await expect(forgeWith(json('{"number":1,"user":"bob"}')).getIssue(1)).rejects.toMatchObject({ code: "http", operation: "getIssue" });
			await expect(forgeWith(json('{"number":1,"labels":[null]}')).getIssue(1)).rejects.toMatchObject({ code: "http", operation: "getIssue" });
			await expect(forgeWith(json('{"number":1,"head":{"ref":5}}')).getPullRequest(1)).rejects.toMatchObject({ code: "http", operation: "getPullRequest" });
			await expect(forgeWith(json('[{"id":"x","user":[]}]')).listComments(1)).rejects.toMatchObject({ code: "http", operation: "listComments" });
		});

		it("statuses: null means no statuses", async () => {
			await expect(forgeWith(json('{"state":"pending","statuses":null}')).getChecks("sha")).resolves.toMatchObject({ state: "none", checks: [] });
		});

		it("an empty body is fine where there is no payload", async () => {
			const forge = forgeWith(json("", 204));
			await expect(forge.closeIssue(1)).resolves.toBeUndefined();
		});
	});
});
