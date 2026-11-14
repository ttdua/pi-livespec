import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import { GiteaForge } from "../../src/forge/gitea.ts";
import { runContract } from "./contract.ts";
import { FAKE_TOKEN } from "./fake-gitea.ts";
import { GiteaWorld } from "./gitea-world.ts";

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
});
