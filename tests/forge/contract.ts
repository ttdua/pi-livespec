// Shared contract suite. Adapter test files call `runContract` with a factory
// for their backend; this file registers no tests on its own.

import { afterEach, describe, expect, it } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import { LABEL_LIVESPEC, phaseLabel } from "../../src/forge/labels.ts";
import { assertOwnMarkedComment, readMarkedComments, writeMarked } from "../../src/forge/markers.ts";
import { BOT_LOGIN, type ContractWorld, OTHER_LOGIN, type WorldFactory } from "./world.ts";

/** Registers the contract tests for one backend under `describe(name)`. */
export function runContract(name: string, makeWorld: WorldFactory): void {
	describe(`forge contract: ${name}`, () => {
		const worlds: ContractWorld[] = [];

		async function world(): Promise<ContractWorld> {
			const w = await makeWorld();
			worlds.push(w);
			return w;
		}

		afterEach(async () => {
			for (const w of worlds.splice(0)) await w.dispose?.();
		});

		describe("identity", () => {
			it("whoami returns the login", async () => {
				const w = await world();
				expect(await w.forge.whoami()).toEqual({ login: BOT_LOGIN });
			});
		});

		describe("issues", () => {
			it("getIssue has version", async () => {
				const w = await world();
				const n = await w.seedIssue({ title: "T", body: "B", labels: ["a"] });
				const issue = await w.forge.getIssue(n);
				expect(issue.version).toBeTruthy();
				expect(issue).toMatchObject({ number: n, title: "T", body: "B", labels: ["a"], state: "open" });
			});

			it("createIssue returns the created issue", async () => {
				const w = await world();
				const created = await w.forge.createIssue({ title: "New", body: "Body", labels: ["x"] });
				expect(created).toMatchObject({ title: "New", body: "Body", labels: ["x"], state: "open" });
				expect(created.version).toBeTruthy();
				expect(await w.bodyOf(created.number)).toBe("Body");
			});

			it("searchIssues filters by label, state and text", async () => {
				const w = await world();
				const a = await w.seedIssue({ title: "alpha widget", labels: ["livespec"] });
				const b = await w.seedIssue({ title: "beta", labels: ["livespec"], state: "closed" });
				await w.seedIssue({ title: "gamma" });

				const open = await w.forge.searchIssues({ labels: ["livespec"] });
				expect(open.map((i) => i.number)).toEqual([a]);

				const all = await w.forge.searchIssues({ labels: ["livespec"], state: "all" });
				expect(all.map((i) => i.number).sort()).toEqual([a, b].sort());

				const text = await w.forge.searchIssues({ text: "widget" });
				expect(text.map((i) => i.number)).toEqual([a]);
			});

			it("closeIssue and reopenIssue change state", async () => {
				const w = await world();
				const n = await w.seedIssue();
				await w.forge.closeIssue(n);
				expect((await w.forge.getIssue(n)).state).toBe("closed");
				await w.forge.reopenIssue(n);
				expect((await w.forge.getIssue(n)).state).toBe("open");
			});

			it("stale body edit gives conflict", async () => {
				const w = await world();
				const n = await w.seedIssue({ body: "original" });
				const read = await w.forge.getIssue(n);
				await w.editBodyBehindBack(n, "edited elsewhere");

				const result = await w.forge.updateIssueBody(n, "mine", read.version);

				expect(result.status).toBe("conflict");
				if (result.status === "conflict") expect(result.changed).toContain("body");
				expect(await w.bodyOf(n)).toBe("edited elsewhere");
			});

			it("current version edit is written", async () => {
				const w = await world();
				const n = await w.seedIssue({ body: "original" });
				const read = await w.forge.getIssue(n);

				const result = await w.forge.updateIssueBody(n, "mine", read.version);

				expect(result.status).toBe("written");
				if (result.status === "written") {
					expect(result.issue.body).toBe("mine");
					expect(result.issue.version).toBeTruthy();
					expect(result.issue.version).not.toBe(read.version);
					expect(["strict", "best-effort"]).toContain(result.check);
				}
				expect(await w.bodyOf(n)).toBe("mine");
			});

			it("version from a write can be used for the next edit", async () => {
				const w = await world();
				const n = await w.seedIssue({ body: "v0" });
				const first = await w.forge.updateIssueBody(n, "v1", (await w.forge.getIssue(n)).version);
				if (first.status !== "written") throw new Error("first write was not written");

				const second = await w.forge.updateIssueBody(n, "v2", first.issue.version);

				expect(second.status).toBe("written");
				expect(await w.bodyOf(n)).toBe("v2");
			});
		});

		describe("labels", () => {
			it("addLabels and removeLabels change issue labels", async () => {
				const w = await world();
				const n = await w.seedIssue({ labels: ["keep"] });
				await w.forge.addLabels(n, [LABEL_LIVESPEC, phaseLabel("spec")]);
				expect((await w.forge.getIssue(n)).labels.sort()).toEqual(["keep", LABEL_LIVESPEC, phaseLabel("spec")].sort());

				await w.forge.removeLabels(n, [LABEL_LIVESPEC]);
				expect((await w.forge.getIssue(n)).labels.sort()).toEqual(["keep", phaseLabel("spec")].sort());
			});

			it("missing label created", async () => {
				const w = await world();
				const n = await w.seedIssue();
				expect(await w.hasLabel("livespec:parked")).toBe(false);

				await w.forge.addLabels(n, ["livespec:parked"]);

				expect(await w.hasLabel("livespec:parked")).toBe(true);
				expect((await w.forge.getIssue(n)).labels).toContain("livespec:parked");
				expect(await w.labelCreateCount("livespec:parked")).toBe(1);
			});

			it("dropped label is created again", async () => {
				const w = await world();
				const n = await w.seedIssue();
				await w.forge.addLabels(n, ["gone"]);
				await w.dropLabel("gone");
				expect(await w.hasLabel("gone")).toBe(false);

				await w.forge.addLabels(n, ["gone"]);

				expect(await w.hasLabel("gone")).toBe(true);
				expect((await w.forge.getIssue(n)).labels).toContain("gone");
			});

			it("existing label applied without creating it again", async () => {
				const w = await world();
				const m = await w.seedIssue({ labels: ["livespec"] });

				await w.forge.addLabels(m, ["livespec"]);

				expect((await w.forge.getIssue(m)).labels).toContain("livespec");
				expect(await w.labelCreateCount("livespec")).toBe(0);
			});
		});

		describe("comments", () => {
			it("create, list and edit a comment", async () => {
				const w = await world();
				const n = await w.seedIssue();
				const created = await w.forge.createComment(n, "hello");
				expect(created).toMatchObject({ author: BOT_LOGIN, body: "hello" });
				expect(created.id).toBeTruthy();
				expect(created.version).toBeTruthy();

				const listed = await w.forge.listComments(n);
				expect(listed.map((c) => c.id)).toEqual([created.id]);
				expect(listed[0]).toMatchObject({ author: BOT_LOGIN, body: "hello" });

				const result = await w.forge.updateComment(created.id, "edited", created.version);
				expect(result.status).toBe("written");
				expect(await w.commentBodyOf(created.id)).toBe("edited");
				expect((await w.forge.listComments(n))[0].body).toBe("edited");
			});

			it("listComments includes comments from other accounts", async () => {
				const w = await world();
				const n = await w.seedIssue();
				await w.postComment(n, OTHER_LOGIN, "from other");
				const listed = await w.forge.listComments(n);
				expect(listed).toHaveLength(1);
				expect(listed[0]).toMatchObject({ author: OTHER_LOGIN, body: "from other" });
			});
		});

		describe("markers", () => {
			it("foreign marker ignored", async () => {
				const w = await world();
				const n = await w.seedIssue();
				await w.postComment(n, OTHER_LOGIN, writeMarked("decision", "d1", { choice: "x" }));

				const read = await readMarkedComments(w.forge, n);

				expect(read.comments).toEqual([]);
				expect(read.warnings).toHaveLength(1);
				expect(read.warnings[0]).toContain(OTHER_LOGIN);
			});

			it("own marked comment is returned with data", async () => {
				const w = await world();
				const n = await w.seedIssue();
				const created = await w.forge.createComment(n, writeMarked("receipt", "u1", { ok: true, n: 3 }));

				const read = await readMarkedComments(w.forge, n);

				expect(read.warnings).toEqual([]);
				expect(read.comments).toEqual([
					{ commentId: created.id, kind: "receipt", id: "u1", author: BOT_LOGIN, data: { ok: true, n: 3 } },
				]);
			});

			it("plain comment is neither returned nor warned", async () => {
				const w = await world();
				const n = await w.seedIssue();
				await w.postComment(n, OTHER_LOGIN, "just a remark");
				await w.forge.createComment(n, "my own remark");

				const read = await readMarkedComments(w.forge, n);

				expect(read).toEqual({ comments: [], warnings: [] });
			});

			it("foreign comment edit refused", async () => {
				const w = await world();
				const n = await w.seedIssue();
				const body = writeMarked("decision", "d1", { choice: "x" });
				const id = await w.postComment(n, OTHER_LOGIN, body);
				const [foreign] = await w.forge.listComments(n);

				await expect(assertOwnMarkedComment(w.forge, foreign)).rejects.toBeInstanceOf(ForgeError);

				expect(await w.commentBodyOf(id)).toBe(body);
			});

			it("own marked comment edit allowed", async () => {
				const w = await world();
				const n = await w.seedIssue();
				const created = await w.forge.createComment(n, writeMarked("receipt", "u1", { v: 1 }));

				await expect(assertOwnMarkedComment(w.forge, created)).resolves.toBeUndefined();
			});
		});

		describe("pull requests", () => {
			it("create, find, list, get and update a pull request", async () => {
				const w = await world();
				const created = await w.forge.createPullRequest({ head: "feat/a", base: "main", title: "Add A", body: "body A" });
				expect(created).toMatchObject({ state: "open", merged: false, head: "feat/a", base: "main", title: "Add A", body: "body A" });
				expect(created.version).toBeTruthy();

				const found = await w.forge.findOpenPullRequest("feat/a");
				expect(found?.number).toBe(created.number);
				expect(await w.forge.findOpenPullRequest("feat/none")).toBeNull();

				const listed = await w.forge.listPullRequests({ state: "open", head: "feat/a" });
				expect(listed.map((p) => p.number)).toEqual([created.number]);

				const got = await w.forge.getPullRequest(created.number);
				expect(got).toMatchObject({ head: "feat/a", base: "main", merged: false });

				const result = await w.forge.updatePullRequest(created.number, { title: "Add A2", body: "new body" }, got.version);
				expect(result.status).toBe("written");
				const after = await w.forge.getPullRequest(created.number);
				expect(after).toMatchObject({ title: "Add A2", body: "new body" });
				expect(after.version).not.toBe(got.version);
			});

			it("listPullRequests filters by state", async () => {
				const w = await world();
				const open = await w.seedPullRequest({ head: "feat/open" });
				const closed = await w.seedPullRequest({ head: "feat/closed", state: "closed" });
				const merged = await w.seedPullRequest({ head: "feat/merged", state: "closed", merged: true });

				const openList = await w.forge.listPullRequests({ state: "open" });
				expect(openList.map((p) => p.number)).toEqual([open]);

				const closedList = await w.forge.listPullRequests({ state: "closed" });
				expect(closedList.map((p) => p.number).sort()).toEqual([closed, merged].sort());

				const all = await w.forge.listPullRequests({ state: "all" });
				expect(all).toHaveLength(3);
				expect((await w.forge.getPullRequest(merged)).merged).toBe(true);
				expect(await w.forge.findOpenPullRequest("feat/closed")).toBeNull();
			});

			it("stale pull request body edit gives conflict", async () => {
				const w = await world();
				const n = await w.seedPullRequest({ head: "feat/b", body: "original" });
				const read = await w.forge.getPullRequest(n);
				await w.editPullRequestBodyBehindBack(n, "edited elsewhere");

				const result = await w.forge.updatePullRequest(n, { body: "mine" }, read.version);

				expect(result.status).toBe("conflict");
				if (result.status === "conflict") expect(result.changed).toContain("body");
				expect((await w.forge.getPullRequest(n)).body).toBe("edited elsewhere");
			});

			it("getPullRequestFiles lists changed paths", async () => {
				const w = await world();
				const n = await w.seedPullRequest({ head: "feat/f", files: ["a.ts", "dir/b.md"] });
				expect((await w.forge.getPullRequestFiles(n)).sort()).toEqual(["a.ts", "dir/b.md"]);
			});
		});

		describe("reviews", () => {
			it("listReviews returns reviews with state", async () => {
				const w = await world();
				const n = await w.seedPullRequest({ head: "feat/r" });
				await w.seedReview(n, { author: OTHER_LOGIN, state: "approved", body: "lgtm" });
				await w.seedReview(n, { author: "carol", state: "changes_requested", body: "fix it" });

				const reviews = await w.forge.listReviews(n);

				expect(reviews).toHaveLength(2);
				expect(reviews).toContainEqual({ author: OTHER_LOGIN, state: "approved", body: "lgtm" });
				expect(reviews).toContainEqual({ author: "carol", state: "changes_requested", body: "fix it" });
			});

			it("createReviewComment is listed with path and line", async () => {
				const w = await world();
				const n = await w.seedPullRequest({ head: "feat/c", files: ["src/x.ts"] });

				await w.forge.createReviewComment(n, { path: "src/x.ts", line: 7, body: "nit" });

				const comments = await w.forge.listReviewComments(n);
				expect(comments).toHaveLength(1);
				expect(comments[0]).toMatchObject({ path: "src/x.ts", line: 7, body: "nit", author: BOT_LOGIN });
				expect(await w.reviewCommentsOf(n)).toHaveLength(1);
			});
		});

		describe("checks", () => {
			it("getChecks returns none without statuses", async () => {
				const w = await world();
				expect(await w.forge.getChecks("sha-empty")).toEqual({ state: "none", checks: [] });
			});

			it("getChecks summarizes statuses", async () => {
				const w = await world();
				await w.seedStatus("sha-1", { name: "build", state: "success", url: "http://ci/build" });
				await w.seedStatus("sha-1", { name: "lint", state: "failure", url: "http://ci/lint" });

				const summary = await w.forge.getChecks("sha-1");

				expect(summary.state).toBe("failure");
				expect(summary.checks).toHaveLength(2);
				expect(summary.checks).toContainEqual({ name: "build", state: "success", url: "http://ci/build" });
				expect(summary.checks).toContainEqual({ name: "lint", state: "failure", url: "http://ci/lint" });
			});

			it("getChecks is success when all pass and pending when one is running", async () => {
				const w = await world();
				await w.seedStatus("ok", { name: "build", state: "success" });
				expect((await w.forge.getChecks("ok")).state).toBe("success");
				await w.seedStatus("ok", { name: "slow", state: "pending" });
				expect((await w.forge.getChecks("ok")).state).toBe("pending");
			});
		});

		describe("failures", () => {
			it("unreachable forge throws ForgeError naming the operation", async () => {
				const w = await world();
				const n = await w.seedIssue();
				await w.makeUnreachable();

				const error = await w.forge.getIssue(n).then(
					() => undefined,
					(e: unknown) => e,
				);

				expect(error).toBeInstanceOf(ForgeError);
				expect((error as ForgeError).code).toBe("unreachable");
				expect((error as ForgeError).operation).toBeTruthy();
			});

			it("forge works again after restore", async () => {
				const w = await world();
				const n = await w.seedIssue();
				await w.makeUnreachable();
				await w.restore();
				expect((await w.forge.getIssue(n)).number).toBe(n);
			});
		});
	});
}
