import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeError } from "../../src/forge/errors.ts";
import { GiteaForge } from "../../src/forge/gitea.ts";
import { GitHubForge, type ExecFn, type ExecResult } from "../../src/forge/github.ts";
import { detectForge, type DetectDeps, resolveForgeTarget } from "../../src/forge/detect.ts";
import { FAKE_TOKEN, FakeGitea } from "./fake-gitea.ts";

const REPO = "/work/repo";
const CONFIG_PATH = `${REPO}/.pi/livespec/config.yaml`;

interface FakeFetch {
	fetch: typeof fetch;
	calls: string[];
}

/** Records each URL and answers it with `handler`; a handler that throws simulates a network failure. */
function fakeFetch(handler: (url: string) => Response): FakeFetch {
	const calls: string[] = [];
	const fn = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		calls.push(url);
		return handler(url);
	};
	return { fetch: fn as unknown as typeof fetch, calls };
}

function versionOk(): Response {
	return new Response(JSON.stringify({ version: "1.22.0" }), { status: 200 });
}

function gitRemote(url: string): ExecFn {
	return async (file, args): Promise<ExecResult> => {
		expect(file).toBe("git");
		expect(args).toEqual(["-C", REPO, "remote", "get-url", "origin"]);
		return { stdout: `${url}\n`, stderr: "", code: 0 };
	};
}

interface Scenario {
	origin: string;
	config?: string;
	probe?: FakeFetch;
	/** Path of the `tea` config detection reads; defaults to a missing file. */
	teaConfigPath?: string;
}

/** Builds deps for one scenario; the probe defaults to a host that does not answer Gitea. */
function baseDeps({
	origin,
	config,
	probe = fakeFetch(() => new Response("not found", { status: 404 })),
	teaConfigPath = "/nonexistent/tea.yml",
}: Scenario): {
	deps: DetectDeps;
	probe: FakeFetch;
} {
	const deps: DetectDeps = {
		exec: gitRemote(origin),
		fetch: probe.fetch,
		env: {},
		readFile: async (path) => (path === CONFIG_PATH ? config : undefined),
		homedir: "/home/test",
		platform: "linux",
		teaLookup: { env: {}, teaConfigPath },
	};
	return { deps, probe };
}

/** Writes a temporary `tea` config holding `text`. */
async function teaConfig(text: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "tea-"));
	const path = join(dir, "config.yml");
	await writeFile(path, text);
	return path;
}

describe("detectForge", () => {
	it("selects GitHub for a github.com remote without probing", async () => {
		const { deps, probe } = baseDeps({ origin: "https://github.com/acme/widgets.git" });
		const forge = await detectForge(REPO, deps);
		expect(forge).toBeInstanceOf(GitHubForge);
		expect(forge.kind).toBe("github");
		expect(probe.calls).toEqual([]);
	});

	it("selects a configured GitHub Enterprise host", async () => {
		const { deps, probe } = baseDeps({
			origin: "git@ghe.example.com:acme/widgets.git",
			config: "githubHosts:\n  - ghe.example.com\n",
		});
		const forge = await detectForge(REPO, deps);
		expect(forge).toBeInstanceOf(GitHubForge);
		expect(probe.calls).toEqual([]);
	});

	it("builds the GitHub adapter with the origin host as hostname for a GHE host, and none for github.com", async () => {
		const hostArgsOf = async (origin: string, config?: string): Promise<string[]> => {
			const seen: string[][] = [];
			const { deps } = baseDeps({ origin, config });
			const gitExec = deps.exec;
			deps.exec = async (file, args, input) => {
				if (file === "git") return gitExec(file, args, input);
				seen.push(args);
				return { stdout: JSON.stringify({ login: "bot" }), stderr: "", code: 0 };
			};
			await (await detectForge(REPO, deps)).whoami();
			return seen.flat();
		};

		const ghe = await hostArgsOf("git@ghe.example.com:acme/widgets.git", "githubHosts:\n  - ghe.example.com\n");
		expect(ghe.filter((a) => a === "--hostname")).toHaveLength(2);
		expect(ghe).toContain("ghe.example.com");
		expect(await hostArgsOf("https://github.com/acme/widgets.git")).not.toContain("--hostname");
	});

	describe("GitHub Enterprise authority", () => {
		/** Returns the `--hostname` value of each gh call made by whoami(). */
		const hostnamesOf = async (origin: string, config: string): Promise<string[]> => {
			const values: string[] = [];
			const { deps } = baseDeps({ origin, config });
			const gitExec = deps.exec;
			deps.exec = async (file, args, input) => {
				if (file === "git") return gitExec(file, args, input);
				const at = args.indexOf("--hostname");
				values.push(at === -1 ? "<none>" : args[at + 1]);
				return { stdout: JSON.stringify({ login: "bot" }), stderr: "", code: 0 };
			};
			await (await detectForge(REPO, deps)).whoami();
			return values;
		};

		it("keeps the https port in the hostname for gh auth status and gh api", async () => {
			const values = await hostnamesOf("https://ghe.example:8443/acme/widgets.git", "forge: github\n");
			expect(values.length).toBeGreaterThanOrEqual(2);
			expect(new Set(values)).toEqual(new Set(["ghe.example:8443"]));
		});

		it("matches githubHosts by host without port and by entry written with port", async () => {
			const origin = "https://ghe.example:8443/acme/widgets.git";
			for (const entry of ["ghe.example", "ghe.example:8443"]) {
				const values = await hostnamesOf(origin, `githubHosts:\n  - ${entry}\n`);
				expect(new Set(values)).toEqual(new Set(["ghe.example:8443"]));
			}
		});

		it("never carries an ssh daemon port into the hostname", async () => {
			for (const origin of ["ssh://git@ghe.example:2222/acme/widgets.git", "git@ghe.example:acme/widgets.git"]) {
				const values = await hostnamesOf(origin, "forge: github\n");
				expect(values.length).toBeGreaterThanOrEqual(2);
				expect(new Set(values)).toEqual(new Set(["ghe.example"]));
			}
		});
	});

	it("selects Gitea by config without probing", async () => {
		const { deps, probe } = baseDeps({
			origin: "git@gitea.example.org:acme/widgets.git",
			config: "forge: gitea\nhost: gitea.example.org\n",
		});
		const forge = await detectForge(REPO, deps);
		expect(forge).toBeInstanceOf(GiteaForge);
		expect(forge.kind).toBe("gitea");
		expect(probe.calls).toEqual([]);
	});

	it("selects Gitea when the origin host answers the version probe", async () => {
		const probe = fakeFetch(() => versionOk());
		const { deps } = baseDeps({ origin: "https://git.example.org/acme/widgets.git", probe });
		const forge = await detectForge(REPO, deps);
		expect(forge).toBeInstanceOf(GiteaForge);
		expect(probe.calls).toEqual(["https://git.example.org/api/v1/version"]);
	});

	it("throws unsupported naming the host for an unknown host", async () => {
		const probe = fakeFetch(() => new Response("not found", { status: 404 }));
		const { deps } = baseDeps({ origin: "https://code.example.net/acme/widgets.git", probe });
		const error = await detectForge(REPO, deps).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ForgeError);
		expect((error as ForgeError).code).toBe("unsupported");
		expect((error as ForgeError).message).toContain("code.example.net");
		expect((error as ForgeError).message).toContain("forge: gitea");
	});

	it("honours config forge: github for a host that is not github.com", async () => {
		const probe = fakeFetch(() => versionOk());
		const { deps } = baseDeps({ origin: "https://ghe.example.com/acme/widgets.git", config: "forge: github\n", probe });
		const forge = await detectForge(REPO, deps);
		expect(forge).toBeInstanceOf(GitHubForge);
		expect(probe.calls).toEqual([]);
	});

	it("throws unsupported when the probe answers with a non-200 status", async () => {
		const probe = fakeFetch(() => new Response("boom", { status: 500 }));
		const { deps } = baseDeps({ origin: "https://git.example.org/acme/widgets.git", probe });
		const error = await detectForge(REPO, deps).catch((e: unknown) => e);
		expect((error as ForgeError).code).toBe("unsupported");
	});

	it("throws unsupported saying the probe could not reach the host on a network failure", async () => {
		const probe = fakeFetch(() => {
			throw new TypeError("fetch failed");
		});
		const { deps } = baseDeps({ origin: "https://git.example.org/acme/widgets.git", probe });
		const error = await detectForge(REPO, deps).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ForgeError);
		expect((error as ForgeError).code).toBe("unsupported");
		expect((error as ForgeError).message).toContain("could not reach");
	});

	it("throws unsupported when the origin remote is missing", async () => {
		const deps: DetectDeps = {
			exec: async () => ({ stdout: "", stderr: "error: No such remote 'origin'", code: 2 }),
			fetch: fakeFetch(() => versionOk()).fetch,
			env: {},
			readFile: async () => undefined,
			homedir: "/home/test",
			platform: "linux",
		};
		const error = await detectForge(REPO, deps).catch((e: unknown) => e);
		expect((error as ForgeError).code).toBe("unsupported");
		expect((error as ForgeError).message).toContain("origin");
	});

	it("parses ssh and scp remotes into the host and owner/repo", async () => {
		const scp = fakeFetch(() => versionOk());
		await detectForge(REPO, baseDeps({ origin: "git@git.example.org:acme/widgets", probe: scp }).deps);
		expect(scp.calls).toEqual(["https://git.example.org/api/v1/version"]);

		const ssh = fakeFetch(() => versionOk());
		await detectForge(REPO, baseDeps({ origin: "ssh://git@git.example.org:2222/acme/widgets.git", probe: ssh }).deps);
		expect(ssh.calls).toEqual(["https://git.example.org/api/v1/version"]);
	});

	it("keeps the port of an http remote when probing", async () => {
		const probe = fakeFetch(() => versionOk());
		await detectForge(REPO, baseDeps({ origin: "http://127.0.0.1:3000/acme/widgets.git", probe }).deps);
		expect(probe.calls).toEqual(["http://127.0.0.1:3000/api/v1/version"]);
	});

	it("probes the giteaUrl override instead of the origin host", async () => {
		const probe = fakeFetch(() => versionOk());
		const { deps } = baseDeps({
			origin: "git@internal.example:acme/widgets.git",
			config: "giteaUrl: https://proxy.example.org/gitea\n",
			probe,
		});
		const forge = await detectForge(REPO, deps);
		expect(forge).toBeInstanceOf(GiteaForge);
		expect(probe.calls).toEqual(["https://proxy.example.org/gitea/api/v1/version"]);
	});

	it("throws unsupported for a remote without owner and repo", async () => {
		const { deps } = baseDeps({ origin: "https://git.example.org/widgets" });
		const error = await detectForge(REPO, deps).catch((e: unknown) => e);
		expect((error as ForgeError).code).toBe("unsupported");
	});
});

describe("detectForge with an account", () => {
	const fakes: FakeGitea[] = [];
	afterEach(async () => {
		for (const fake of fakes.splice(0)) await fake.close();
	});

	it("Account passed to GitHub", async () => {
		const seen: { args: string[]; env?: Record<string, string> }[] = [];
		const { deps } = baseDeps({ origin: "https://github.com/acme/widgets.git" });
		const gitExec = deps.exec;
		deps.exec = async (file, args, input, env) => {
			if (file === "git") return gitExec(file, args, input, env);
			seen.push({ args, env });
			return { stdout: JSON.stringify({ login: "ttdua" }), stderr: "", code: 0 };
		};
		deps.account = { name: "ttdua", token: "tok-ttdua" };

		const forge = await detectForge(REPO, deps);
		await forge.whoami();

		expect(forge).toBeInstanceOf(GitHubForge);
		expect(seen.length).toBeGreaterThanOrEqual(2);
		for (const call of seen) {
			expect(call.env).toEqual({ GH_TOKEN: "tok-ttdua" });
			expect(call.args.join(" ")).not.toContain("tok-ttdua");
		}
	});

	it("Account passed to Gitea", async () => {
		const fake = await FakeGitea.start({ owner: "acme", repo: "widgets" });
		fakes.push(fake);
		const teaConfigPath = await teaConfig(
			`logins:\n  - name: gitea-admin\n    url: ${fake.url}\n    token: admin-token\n  - name: gitea.example.org\n    url: ${fake.url}\n    token: ${FAKE_TOKEN}\n`,
		);
		const { deps } = baseDeps({ origin: `${fake.url}/acme/widgets.git`, teaConfigPath });
		deps.fetch = globalThis.fetch;
		deps.account = { name: "gitea.example.org" };

		const forge = await detectForge(REPO, deps);
		await forge.whoami();

		expect(forge).toBeInstanceOf(GiteaForge);
		const userCall = fake.calls.find((c) => c.path === "/api/v1/user");
		expect(userCall?.authorization).toBe(`token ${FAKE_TOKEN}`);
	});
});

describe("resolveForgeTarget", () => {
	it("resolveForgeTarget returns the giteaUrl override and keeps the port", async () => {
		const { deps, probe } = baseDeps({
			origin: "git@ssh.gitea.example.org:acme/shop.git",
			config: "forge: gitea\ngiteaUrl: https://gitea.example.org:8443\n",
		});
		await expect(resolveForgeTarget(REPO, deps)).resolves.toEqual({
			kind: "gitea",
			host: "gitea.example.org",
			authority: "gitea.example.org:8443",
			baseUrl: "https://gitea.example.org:8443",
			owner: "acme",
			repo: "shop",
		});
		expect(probe.calls).toEqual([]);

		const loopback = baseDeps({ origin: "http://127.0.0.1:3000/acme/shop.git", probe: fakeFetch(() => versionOk()) });
		await expect(resolveForgeTarget(REPO, loopback.deps)).resolves.toEqual({
			kind: "gitea",
			host: "127.0.0.1",
			authority: "127.0.0.1:3000",
			baseUrl: "http://127.0.0.1:3000",
			owner: "acme",
			repo: "shop",
		});
	});

	it("returns the GitHub endpoint for github.com and an Enterprise host", async () => {
		await expect(resolveForgeTarget(REPO, baseDeps({ origin: "git@github.com:acme/widgets.git" }).deps)).resolves.toEqual({
			kind: "github",
			host: "github.com",
			authority: "github.com",
			baseUrl: "https://github.com",
			owner: "acme",
			repo: "widgets",
		});
		const ghe = baseDeps({ origin: "https://ghe.example.org:8443/acme/widgets.git", config: "forge: github\n" });
		await expect(resolveForgeTarget(REPO, ghe.deps)).resolves.toMatchObject({
			kind: "github",
			host: "ghe.example.org",
			authority: "ghe.example.org:8443",
		});
	});

	it("Gitea by configured URL", async () => {
		const { deps, probe } = baseDeps({
			origin: "git@ssh.gitea.example.org:acme/shop.git",
			config: "forge: gitea\ngiteaUrl: https://gitea.example.org\n",
		});

		const forge = await detectForge(REPO, deps);

		expect(forge).toBeInstanceOf(GiteaForge);
		await expect(resolveForgeTarget(REPO, deps)).resolves.toMatchObject({ kind: "gitea", baseUrl: "https://gitea.example.org", host: "gitea.example.org" });
		expect(probe.calls).toEqual([]);
	});

	it("Gitea by tea SSH host", async () => {
		const teaConfigPath = await teaConfig(
			"logins:\n  - name: gitea.example.org\n    url: https://gitea.example.org\n    token: tok\n    ssh_host: SSH.Gitea.Example.org\n",
		);
		const { deps, probe } = baseDeps({ origin: "git@ssh.gitea.example.org:acme/shop.git", teaConfigPath });

		const forge = await detectForge(REPO, deps);

		expect(forge).toBeInstanceOf(GiteaForge);
		await expect(resolveForgeTarget(REPO, deps)).resolves.toEqual({
			kind: "gitea",
			host: "gitea.example.org",
			authority: "gitea.example.org",
			baseUrl: "https://gitea.example.org",
			owner: "acme",
			repo: "shop",
		});
		expect(probe.calls).toEqual([]);
	});

	it("tea SSH host matches with the port ignored on both sides", async () => {
		const teaConfigPath = await teaConfig(
			"logins:\n  - name: gitea.example.org\n    url: https://gitea.example.org\n    token: tok\n    ssh_host: SSH.Gitea.Example.org:2222\n",
		);
		for (const origin of ["ssh://git@ssh.gitea.example.org:2222/acme/shop.git", "git@ssh.gitea.example.org:acme/shop.git"]) {
			const { deps, probe } = baseDeps({ origin, teaConfigPath });

			await expect(resolveForgeTarget(REPO, deps)).resolves.toMatchObject({ kind: "gitea", baseUrl: "https://gitea.example.org", host: "gitea.example.org" });
			expect(probe.calls).toEqual([]);
		}
	});

	it("tea SSH host shared by two URLs falls back to the probe", async () => {
		const teaConfigPath = await teaConfig(
			[
				"logins:",
				"  - name: a",
				"    url: https://gitea.example.org",
				"    token: tok-a",
				"    ssh_host: ssh.gitea.example.org",
				"  - name: b",
				"    url: https://other.example.org",
				"    token: tok-b",
				"    ssh_host: ssh.gitea.example.org",
				"",
			].join("\n"),
		);
		const probe = fakeFetch(() => versionOk());
		const { deps } = baseDeps({ origin: "git@ssh.gitea.example.org:acme/shop.git", teaConfigPath, probe });

		await expect(resolveForgeTarget(REPO, deps)).resolves.toMatchObject({ kind: "gitea", baseUrl: "https://ssh.gitea.example.org" });
		expect(probe.calls).toEqual(["https://ssh.gitea.example.org/api/v1/version"]);
	});
});
