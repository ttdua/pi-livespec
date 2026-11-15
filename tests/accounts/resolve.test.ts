import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseAccount, resolveAccount } from "../../src/accounts/resolve.ts";
import { defaultGitExec, type GitExec } from "../../src/engine/git-exec.ts";
import { makeRepo } from "../helpers/repo.ts";
import { type FakeAccount, type FakeGiteaRepo, fakeEnv, fakeGh, fakeGiteaRepo, giteaTarget, githubTarget, teaConfig } from "./fakes.ts";

const NO_UI = { hasUI: false };
const GITHUB_REMOTE = "github.com/acme/widgets";
const TTDUA: FakeAccount = { login: "ttdua", token: "tok-ttdua", repo: true };
const NAICOI: FakeAccount = { login: "naicoi92", token: "tok-naicoi", repo: false };

let gitea: FakeGiteaRepo | undefined;
afterEach(async () => {
	await gitea?.close();
	gitea = undefined;
});

/** `git config --local --get <key>` of the repo, or `undefined` when unset. */
function localGet(root: string, key: string): string | undefined {
	try {
		return execFileSync("git", ["config", "--local", "--get", key], { cwd: root, encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
}

/** Real git, recording each `git config` write (`--local` without `--get`). */
function recordingGit(): { git: GitExec; writes: string[][] } {
	const writes: string[][] = [];
	const git: GitExec = (args, opts) => {
		if (args[0] === "config" && !args.includes("--get")) writes.push(args);
		return defaultGitExec(args, opts);
	};
	return { git, writes };
}

/** A GitHub world: the scripted `gh` over `accounts`, a temp repo and real git. */
async function githubWorld(accounts: FakeAccount[], env: Record<string, string> = {}) {
	const gh = fakeGh({ accounts, active: accounts[0]?.login });
	const root = await makeRepo();
	const { git, writes } = recordingGit();
	return { gh, root, writes, env: fakeEnv({ exec: gh.exec, git, env }), target: githubTarget() };
}

/** A loopback Gitea with one tea login per account (named after it), a temp repo and real git. */
async function giteaWorld(accounts: FakeAccount[]) {
	gitea = await fakeGiteaRepo(accounts);
	const logins = accounts.map((a) => `  - name: ${a.login}\n    url: ${gitea?.url}\n    user: ${a.login}-user\n    token: ${a.token}\n`);
	const teaConfigPath = await teaConfig(`logins:\n${logins.join("")}`);
	const root = await makeRepo();
	const { git, writes } = recordingGit();
	return { root, writes, env: fakeEnv({ teaConfigPath, fetch: globalThis.fetch, git }), target: giteaTarget(gitea.url) };
}

const GITEA_WRITERS: FakeAccount[] = [
	{ login: "gitea.example.org", token: "tok-g1", repo: true },
	{ login: "gitea-admin", token: "tok-g2", repo: true },
];

describe("resolveAccount", () => {
	it("Answer stored", async () => {
		const w = await giteaWorld(GITEA_WRITERS);
		const select = vi.fn(async (_title: string, options: string[]) => options.find((o) => o.startsWith("gitea.example.org ")));

		const first = await resolveAccount(w.target, w.root, { hasUI: true, select }, w.env);

		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[1]).toEqual(["gitea.example.org (gitea.example.org-user) — can push", "gitea-admin (gitea-admin-user) — can push"]);
		expect(first).toMatchObject({ source: "asked", account: "gitea.example.org", user: "gitea.example.org-user", token: "tok-g1", unverified: false });
		expect(first.block).toBeUndefined();
		expect(localGet(w.root, "livespec.account")).toBe("gitea.example.org");

		const again = vi.fn(async () => undefined);
		const next = await resolveAccount(w.target, w.root, { hasUI: true, select: again }, w.env);
		expect(again).not.toHaveBeenCalled();
		expect(next).toMatchObject({ source: "stored", account: "gitea.example.org" });
		expect(next.notice).toBeUndefined();
	});

	it("Cancelled", async () => {
		const w = await giteaWorld(GITEA_WRITERS);

		const r = await resolveAccount(w.target, w.root, { hasUI: true, select: async () => undefined }, w.env);

		expect(r.account).toBeUndefined();
		expect(r.block).toContain("/livespec account <name>");
		expect(r.block).toContain("gitea.example.org");
		expect(r.block).toContain("gitea-admin");
		expect(localGet(w.root, "livespec.account")).toBeUndefined();
		const noUi = await resolveAccount(w.target, w.root, NO_UI, w.env);
		expect(r.block).toBe(noUi.block);
	});

	it("ui select throwing is treated as cancelled", async () => {
		const w = await giteaWorld(GITEA_WRITERS);
		const select = async (): Promise<string | undefined> => {
			throw new Error("the UI went away");
		};

		const r = await resolveAccount(w.target, w.root, { hasUI: true, select }, w.env);

		expect(r.account).toBeUndefined();
		expect(r.block).toContain("/livespec account <name>");
		expect(localGet(w.root, "livespec.account")).toBeUndefined();
	});

	it("env token gives source env without checking candidates", async () => {
		const w = await githubWorld([TTDUA, NAICOI], { GH_TOKEN: "tok-env" });

		const r = await resolveAccount(w.target, w.root, NO_UI, w.env);

		expect(r).toMatchObject({ source: "env", token: "tok-env", unverified: false });
		expect(r.account).toBeUndefined();
		expect(r.block).toBeUndefined();
		expect(r.facts.envToken).toBe(true);
		expect(w.gh.calls).toEqual([]);
		expect(w.writes).toEqual([]);
	});

	it("store happens only for store and ask results", async () => {
		const refused = await githubWorld([NAICOI]);
		expect((await resolveAccount(refused.target, refused.root, NO_UI, refused.env)).block).toBeDefined();
		expect(refused.writes).toEqual([]);

		const env = await githubWorld([TTDUA], { GH_TOKEN: "tok-env" });
		await resolveAccount(env.target, env.root, NO_UI, env.env);
		expect(env.writes).toEqual([]);

		const auto = await githubWorld([TTDUA, NAICOI]);
		await resolveAccount(auto.target, auto.root, NO_UI, auto.env);
		expect(auto.writes).toEqual([
			["config", "--local", "--end-of-options", "livespec.account", "ttdua"],
			["config", "--local", "--end-of-options", "livespec.accountRemote", GITHUB_REMOTE],
		]);
		auto.writes.length = 0;
		const stored = await resolveAccount(auto.target, auto.root, NO_UI, auto.env);
		expect(stored.source).toBe("stored");
		expect(auto.writes).toEqual([]);
	});

	it("notice names the account and why", async () => {
		const w = await githubWorld([TTDUA, NAICOI]);

		const r = await resolveAccount(w.target, w.root, NO_UI, w.env);

		expect(r).toMatchObject({ source: "auto", account: "ttdua", user: "ttdua", token: "tok-ttdua" });
		expect(r.notice).toBe("livespec uses `ttdua` for this repository (chosen automatically)");
		const asked = await giteaWorld(GITEA_WRITERS);
		const pick = async (_t: string, options: string[]) => options[1];
		expect((await resolveAccount(asked.target, asked.root, { hasUI: true, select: pick }, asked.env)).notice).toBe(
			"livespec uses `gitea-admin` for this repository (you chose it)",
		);
	});

	it("messages are redacted", async () => {
		const gh = fakeGh({ accounts: [TTDUA] });
		const root = await makeRepo();
		const git: GitExec = async (args, opts) =>
			args[0] === "config" && !args.includes("--get")
				? { stdout: "", stderr: "error: could not lock config holding tok-ttdua\n", code: 255 }
				: defaultGitExec(args, opts);

		const r = await resolveAccount(githubTarget(), root, NO_UI, fakeEnv({ exec: gh.exec, git }));

		expect(r.block).toBeDefined();
		expect(r.block).not.toContain("tok-ttdua");
		expect(r.block).toContain("***");
		expect(JSON.stringify(r.facts)).not.toContain("tok-ttdua");
	});
});

describe("chooseAccount", () => {
	it("chooseAccount refuses with an env token, an unknown name, or no access", async () => {
		const env = await githubWorld([TTDUA], { GH_TOKEN: "tok-env" });
		const byEnv = await chooseAccount(env.target, env.root, "ttdua", env.env);
		expect(byEnv).toEqual({ ok: false, message: expect.stringContaining("GH_TOKEN") });

		const w = await githubWorld([TTDUA, NAICOI]);
		const unknown = await chooseAccount(w.target, w.root, "nobody", w.env);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) {
			expect(unknown.message).toContain("nobody");
			expect(unknown.message).toContain("ttdua");
			expect(unknown.message).toContain("naicoi92");
		}
		const denied = await chooseAccount(w.target, w.root, "naicoi92", w.env);
		expect(denied).toEqual({ ok: false, message: expect.stringContaining("cannot push") });

		expect(env.writes).toEqual([]);
		expect(w.writes).toEqual([]);
		expect(localGet(w.root, "livespec.account")).toBeUndefined();
	});

	it("chooseAccount stores a writable account", async () => {
		const w = await githubWorld([NAICOI, TTDUA]);

		const r = await chooseAccount(w.target, w.root, "ttdua", w.env);

		expect(r.ok).toBe(true);
		if (r.ok) expect(r.resolved).toMatchObject({ source: "asked", account: "ttdua", user: "ttdua", token: "tok-ttdua", unverified: false });
		expect(localGet(w.root, "livespec.account")).toBe("ttdua");
		expect(localGet(w.root, "livespec.accountRemote")).toBe(GITHUB_REMOTE);
	});
});
