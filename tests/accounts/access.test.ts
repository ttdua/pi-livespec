import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_CONCURRENCY, ACCESS_TIMEOUT_MS, checkAccess, checkAll } from "../../src/accounts/access.ts";
import { candidateToken } from "../../src/accounts/token.ts";
import { type FakeAccount, type FakeGiteaRepo, fakeEnv, fakeGh, fakeGiteaRepo, giteaTarget, githubTarget, teaConfig } from "./fakes.ts";

const candidate = (name: string) => ({ name, user: name });

let gitea: FakeGiteaRepo | undefined;
afterEach(async () => {
	vi.useRealTimers();
	await gitea?.close();
	gitea = undefined;
});

/** A loopback Gitea plus a tea config with one login per account, named after its login. */
async function giteaWorld(accounts: FakeAccount[]) {
	gitea = await fakeGiteaRepo(accounts);
	const logins = accounts.map((a) => `  - name: ${a.login}\n    url: ${gitea?.url}\n    user: ${a.login}\n    token: ${a.token}\n`);
	const teaConfigPath = await teaConfig(`logins:\n${logins.join("")}`);
	return { env: fakeEnv({ teaConfigPath, fetch: globalThis.fetch }), target: giteaTarget(gitea.url) };
}

describe("checkAccess on GitHub", () => {
	it("Push permission", async () => {
		const gh = fakeGh({
			accounts: [
				{ login: "ttdua", token: "tok-ttdua", repo: true },
				{ login: "naicoi92", token: "tok-naicoi", repo: false },
			],
			active: "naicoi92",
		});
		const env = fakeEnv({ exec: gh.exec });

		await expect(checkAccess(env, githubTarget(), candidate("ttdua"))).resolves.toBe("true");
		await expect(checkAccess(env, githubTarget(), candidate("naicoi92"))).resolves.toBe("false");
	});

	it("Missing field", async () => {
		const gh = fakeGh({ accounts: [{ login: "ttdua", token: "tok-ttdua", repo: "missing" }] });

		await expect(checkAccess(fakeEnv({ exec: gh.exec }), githubTarget(), candidate("ttdua"))).resolves.toBe("unknown");
	});

	it("Unreachable", async () => {
		const gh = fakeGh({ accounts: [{ login: "ttdua", token: "tok-ttdua", repo: "unreachable" }] });

		await expect(checkAccess(fakeEnv({ exec: gh.exec }), githubTarget(), candidate("ttdua"))).resolves.toBe("unknown");
	});

	it("HTTP 401, 403 and 404 count as no access", async () => {
		for (const status of [401, 403, 404]) {
			const gh = fakeGh({ accounts: [{ login: "ttdua", token: "tok-ttdua", repo: { status } }] });

			await expect(checkAccess(fakeEnv({ exec: gh.exec }), githubTarget(), candidate("ttdua"))).resolves.toBe("false");
		}
	});

	it("a candidate without a token is unknown", async () => {
		const gh = fakeGh({ accounts: [] });

		await expect(checkAccess(fakeEnv({ exec: gh.exec }), githubTarget(), candidate("ghost"))).resolves.toBe("unknown");
	});

	it("access check times out as unknown", async () => {
		vi.useFakeTimers();
		const gh = fakeGh({ accounts: [{ login: "ttdua", token: "tok-ttdua", repo: "hang" }] });

		const pending = checkAccess(fakeEnv({ exec: gh.exec }), githubTarget(), candidate("ttdua"));
		await vi.advanceTimersByTimeAsync(ACCESS_TIMEOUT_MS);

		await expect(pending).resolves.toBe("unknown");
	});

	it("check uses the candidate token and not the active account", async () => {
		const gh = fakeGh({
			accounts: [
				{ login: "ttdua", token: "tok-ttdua", repo: true },
				{ login: "naicoi92", token: "tok-naicoi", repo: false },
			],
			active: "naicoi92",
		});

		await checkAccess(fakeEnv({ exec: gh.exec }), githubTarget(), candidate("ttdua"));

		const apiCall = gh.calls.find((c) => c.args[0] === "api");
		expect(apiCall?.args).toEqual(["api", "repos/acme/widgets", "--hostname", "github.com"]);
		expect(apiCall?.env).toEqual({ GH_TOKEN: "tok-ttdua" });
		expect(gh.calls.some((c) => c.args.includes("switch"))).toBe(false);
		for (const call of gh.calls) expect(call.args.join(" ")).not.toContain("tok-");
	});

	it("an Enterprise Server host gets the token in GH_ENTERPRISE_TOKEN", async () => {
		const gh = fakeGh({ accounts: [{ login: "ttdua", token: "tok-ttdua", repo: true }] });

		await expect(checkAccess(fakeEnv({ exec: gh.exec }), githubTarget("ghe.example.org"), candidate("ttdua"))).resolves.toBe("true");

		const apiCall = gh.calls.find((c) => c.args[0] === "api");
		expect(apiCall?.env).toEqual({ GH_ENTERPRISE_TOKEN: "tok-ttdua" });
		expect(gh.calls.find((c) => c.args[1] === "token")?.args).toEqual(["auth", "token", "--hostname", "ghe.example.org", "--user", "ttdua"]);
	});
});

describe("checkAccess on Gitea", () => {
	it("Push permission", async () => {
		const { env, target } = await giteaWorld([
			{ login: "gitea-main", token: "tok-main", repo: true },
			{ login: "gitea-admin", token: "tok-admin", repo: false },
		]);

		await expect(checkAccess(env, target, candidate("gitea-main"))).resolves.toBe("true");
		await expect(checkAccess(env, target, candidate("gitea-admin"))).resolves.toBe("false");
		expect(gitea?.authorizations).toEqual(["token tok-main", "token tok-admin"]);
	});

	it("Missing field", async () => {
		const { env, target } = await giteaWorld([{ login: "gitea-main", token: "tok-main", repo: "missing" }]);

		await expect(checkAccess(env, target, candidate("gitea-main"))).resolves.toBe("unknown");
	});

	it("Unreachable", async () => {
		const { env, target } = await giteaWorld([{ login: "gitea-main", token: "tok-main", repo: "unreachable" }]);

		await expect(checkAccess(env, target, candidate("gitea-main"))).resolves.toBe("unknown");
	});

	it("HTTP 401, 403 and 404 count as no access", async () => {
		for (const status of [401, 403, 404]) {
			const { env, target } = await giteaWorld([{ login: "gitea-main", token: "tok-main", repo: { status } }]);

			await expect(checkAccess(env, target, candidate("gitea-main"))).resolves.toBe("false");
			await gitea?.close();
			gitea = undefined;
		}
	});

	it("access check times out as unknown", async () => {
		const { env, target } = await giteaWorld([{ login: "gitea-main", token: "tok-main", repo: "hang" }]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const pending = checkAccess(env, target, candidate("gitea-main"));
		await vi.advanceTimersByTimeAsync(ACCESS_TIMEOUT_MS);

		await expect(pending).resolves.toBe("unknown");
	});

	it("GITEA_TOKEN in the environment does not replace the candidate token", async () => {
		const { target } = await giteaWorld([{ login: "gitea-main", token: "tok-main", repo: true }]);
		const teaConfigPath = await teaConfig(`logins:\n  - name: gitea-main\n    url: ${gitea?.url}\n    token: tok-main\n`);
		const env = fakeEnv({ fetch: globalThis.fetch });
		env.teaLookup = { env: { GITEA_TOKEN: "env-token" }, teaConfigPath };

		await expect(checkAccess(env, target, candidate("gitea-main"))).resolves.toBe("true");
		expect(gitea?.authorizations).toEqual(["token tok-main"]);
	});
});

describe("candidateToken", () => {
	it("a Gitea login of another host has no token", async () => {
		const teaConfigPath = await teaConfig("logins:\n  - name: other\n    url: https://other.example.org\n    token: tok-other\n");

		await expect(candidateToken(fakeEnv({ teaConfigPath }), giteaTarget("https://gitea.example.org"), "other")).resolves.toBeUndefined();
	});
});

describe("checkAll", () => {
	it("at most four checks run at once", async () => {
		const accounts = Array.from({ length: 9 }, (_, i) => ({ login: `user${i}`, token: `tok-${i}`, repo: i % 2 === 0, delayMs: 20 }));
		const gh = fakeGh({ accounts });

		const results = await checkAll(fakeEnv({ exec: gh.exec }), githubTarget(), accounts.map((a) => candidate(a.login)));

		expect(ACCESS_CONCURRENCY).toBe(4);
		expect(gh.maxInFlight()).toBe(ACCESS_CONCURRENCY);
		expect(results).toEqual(accounts.map((a) => ({ candidate: candidate(a.login), access: a.repo ? "true" : "false" })));
	});
});
