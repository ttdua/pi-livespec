import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AccountForge, readStored, writeStored } from "../../src/accounts/store.ts";
import type { StoredAccount } from "../../src/accounts/types.ts";
import { defaultGitExec, type GitExec } from "../../src/engine/git-exec.ts";
import { makeRepo } from "../helpers/repo.ts";

const STORED = { account: "ttdua", remote: "github.com/acme/widgets" };

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A temp global git config and the env that points git at it, so the user's own config is never read. */
async function isolatedGlobal(text = ""): Promise<{ path: string; env: Record<string, string> }> {
	const dir = await mkdtemp(join(tmpdir(), "gitglobal-"));
	dirs.push(dir);
	const path = join(dir, "gitconfig");
	await writeFile(path, text);
	return { path, env: { GIT_CONFIG_GLOBAL: path, GIT_CONFIG_NOSYSTEM: "1" } };
}

/** `defaultGitExec` with a fixed env, recording every argv. */
function recordingGit(env: Record<string, string>): { git: GitExec; calls: string[][] } {
	const calls: string[][] = [];
	const git: GitExec = (args, opts = {}) => {
		calls.push(args);
		return defaultGitExec(args, { ...opts, env: { ...env, ...opts.env } });
	};
	return { git, calls };
}

function localGet(root: string, key: string): string {
	return execFileSync("git", ["config", "--local", "--get", key], { cwd: root, encoding: "utf8" }).trim();
}

describe("account storage", () => {
	it("Stored locally", async () => {
		const root = await makeRepo();
		const global = await isolatedGlobal();
		const { git } = recordingGit(global.env);

		await writeStored(git, root, STORED, "github");

		expect(localGet(root, "livespec.account")).toBe("ttdua");
		expect(localGet(root, "livespec.accountRemote")).toBe("github.com/acme/widgets");
		expect(await readFile(global.path, "utf8")).toBe("");
		await expect(readStored(git, root)).resolves.toEqual(STORED);
	});

	it("Global value ignored", async () => {
		const root = await makeRepo();
		const global = await isolatedGlobal("[livespec]\n\taccount = naicoi92\n\taccountRemote = github.com/acme/widgets\n");
		const { git } = recordingGit(global.env);

		await expect(readStored(git, root)).resolves.toBeUndefined();
	});

	it("a local account without its remote is not stored", async () => {
		const root = await makeRepo();
		const global = await isolatedGlobal();
		const { git } = recordingGit(global.env);
		execFileSync("git", ["config", "--local", "livespec.account", "ttdua"], { cwd: root });

		await expect(readStored(git, root)).resolves.toBeUndefined();
	});

	it("Unsafe value refused", async () => {
		const root = await makeRepo();
		const global = await isolatedGlobal();
		const { git, calls } = recordingGit(global.env);
		const unsafe: [StoredAccount, AccountForge][] = [
			[{ account: "evil\nname", remote: STORED.remote }, "gitea"],
			[{ account: "-x", remote: STORED.remote }, "gitea"],
			[{ account: "", remote: STORED.remote }, "gitea"],
			[{ account: "a".repeat(101), remote: STORED.remote }, "gitea"],
			[{ account: "evil\nname", remote: STORED.remote }, "github"],
			[{ account: "-x", remote: STORED.remote }, "github"],
			[{ account: "ttdua", remote: "github.com/acme/widgets\n[core]" }, "github"],
			[{ account: "ttdua", remote: "--remote" }, "github"],
			[{ account: "ttdua", remote: "-github.com/acme/widgets" }, "github"],
			[{ account: "ttdua", remote: "github.com/acme" }, "github"],
			[{ account: "ttdua", remote: "github.com/acme/widgets/extra" }, "github"],
			[{ account: "ttdua", remote: "github.com//widgets" }, "github"],
		];

		for (const [value, forge] of unsafe) await expect(writeStored(git, root, value, forge)).rejects.toThrow(/invalid/);

		expect(calls).toEqual([]);
		await expect(readStored(git, root)).resolves.toBeUndefined();
	});

	it("GitHub names must be GitHub logins", async () => {
		const root = await makeRepo();
		const global = await isolatedGlobal();
		const { git, calls } = recordingGit(global.env);

		for (const account of ["bad/name", "bad name", "a".repeat(40), "-lead", "bad_name"]) {
			await expect(writeStored(git, root, { account, remote: STORED.remote }, "github")).rejects.toThrow(/invalid/);
		}
		expect(calls).toEqual([]);

		await writeStored(git, root, { account: "a".repeat(39), remote: STORED.remote }, "github");
		await expect(readStored(git, root)).resolves.toEqual({ account: "a".repeat(39), remote: STORED.remote });
	});

	it("tea login names keep the generic rule", async () => {
		const root = await makeRepo();
		const global = await isolatedGlobal();
		const { git } = recordingGit(global.env);

		for (const account of ["gitea.example.org", "bad/name", "admin login", "gitea_admin"]) {
			const stored = { account, remote: "gitea.example.org/acme/widgets" };
			await writeStored(git, root, stored, "gitea");
			await expect(readStored(git, root)).resolves.toEqual(stored);
		}
	});

	it("a valid remote longer than 100 characters round-trips", async () => {
		const root = await makeRepo();
		const global = await isolatedGlobal();
		const { git } = recordingGit(global.env);
		const stored = { account: "ttdua", remote: `gitea.example.org:3000/${"o".repeat(60)}/${"r".repeat(60)}` };

		await writeStored(git, root, stored, "gitea");

		await expect(readStored(git, root)).resolves.toEqual(stored);
	});

	it("an unsafe value already in the local config reads as not stored", async () => {
		const root = await makeRepo();
		const global = await isolatedGlobal();
		const { git } = recordingGit(global.env);
		execFileSync("git", ["config", "--local", "livespec.account", "-x"], { cwd: root });
		execFileSync("git", ["config", "--local", "livespec.accountRemote", STORED.remote], { cwd: root });

		await expect(readStored(git, root)).resolves.toBeUndefined();
	});

	it("values are written after --end-of-options", async () => {
		const root = await makeRepo();
		const global = await isolatedGlobal();
		const { git, calls } = recordingGit(global.env);

		await writeStored(git, root, { account: "a-b", remote: STORED.remote }, "github");
		await readStored(git, root);

		expect(calls).toEqual([
			["config", "--local", "--end-of-options", "livespec.account", "a-b"],
			["config", "--local", "--end-of-options", "livespec.accountRemote", STORED.remote],
			["config", "--local", "--get", "--end-of-options", "livespec.account"],
			["config", "--local", "--get", "--end-of-options", "livespec.accountRemote"],
		]);
	});

	it("a git failure while writing throws with git's message", async () => {
		const notARepo = await mkdtemp(join(tmpdir(), "norepo-"));
		dirs.push(notARepo);
		const global = await isolatedGlobal();
		const { git } = recordingGit({ ...global.env, GIT_CEILING_DIRECTORIES: tmpdir() });

		await expect(writeStored(git, notARepo, STORED, "github")).rejects.toThrow(/git config/);
	});
});
