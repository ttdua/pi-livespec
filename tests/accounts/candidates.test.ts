import { describe, expect, it } from "vitest";
import { listCandidates } from "../../src/accounts/candidates.ts";
import { fakeEnv, fakeGh, giteaTarget, githubTarget, teaConfig } from "./fakes.ts";

const GITEA_LOGINS = [
	"logins:",
	"  - name: gitea.example.org",
	"    url: https://gitea.example.org",
	"    user: dua",
	"    token: tok-main",
	"    ssh_host: ssh.gitea.example.org",
	"    default: true",
	"  - name: gitea-admin",
	"    url: https://gitea.example.org/",
	"    user: admin",
	"    token: tok-admin",
	"  - name: other",
	"    url: https://other.example.org",
	"    user: someone",
	"    token: tok-other",
	"",
].join("\n");

describe("listCandidates", () => {
	it("GitHub candidates", async () => {
		const gh = fakeGh({
			accounts: [
				{ login: "ttdua", token: "t1", repo: true },
				{ login: "naicoi92", token: "t2", repo: false },
			],
			active: "naicoi92",
		});

		const result = await listCandidates(fakeEnv({ exec: gh.exec }), githubTarget());

		expect(result).toEqual({
			candidates: [
				{ name: "ttdua", user: "ttdua" },
				{ name: "naicoi92", user: "naicoi92" },
			],
		});
		expect(gh.calls.map((c) => c.args)).toEqual([["auth", "status", "--hostname", "github.com", "--json", "hosts"]]);
	});

	it("Gitea candidates", async () => {
		const teaConfigPath = await teaConfig(GITEA_LOGINS);

		const result = await listCandidates(fakeEnv({ teaConfigPath }), giteaTarget("https://gitea.example.org"));

		expect(result).toEqual({
			candidates: [
				{ name: "gitea.example.org", user: "dua" },
				{ name: "gitea-admin", user: "admin" },
			],
		});
	});

	it("Gitea candidates behind an SSH host", async () => {
		const teaConfigPath = await teaConfig(GITEA_LOGINS);
		// The target resolved from `git@ssh.gitea.example.org:acme/shop.git` carries the web host, not origin's.
		const target = { ...giteaTarget("https://gitea.example.org"), repo: "shop" };

		const result = await listCandidates(fakeEnv({ teaConfigPath }), target);

		expect(result.candidates.map((c) => c.name)).toEqual(["gitea.example.org", "gitea-admin"]);
	});

	it("gh without json status gives no candidates and a reason", async () => {
		const gh = fakeGh({ accounts: [{ login: "ttdua", token: "t1", repo: true }], noJsonStatus: true });

		const result = await listCandidates(fakeEnv({ exec: gh.exec }), githubTarget());

		expect(result.candidates).toEqual([]);
		expect(result.reason).toMatch(/gh auth status --json/);
		expect(result.reason).toMatch(/upgrade gh/);
	});

	it("gh status that is not the expected JSON gives no candidates and a reason", async () => {
		for (const statusStdout of ["not json", '{"hosts":{"github.com":"nope"}}', "null"]) {
			const gh = fakeGh({ accounts: [], statusStdout });

			const result = await listCandidates(fakeEnv({ exec: gh.exec }), githubTarget());

			expect(result.candidates).toEqual([]);
			expect(result.reason).toBeTruthy();
		}
	});

	it("no gh account on the host gives a login hint", async () => {
		const gh = fakeGh({ accounts: [] });

		const result = await listCandidates(fakeEnv({ exec: gh.exec }), githubTarget("ghe.example.org"));

		expect(result).toEqual({ candidates: [], reason: expect.stringContaining("gh auth login --hostname ghe.example.org") });
	});

	it("malformed tea config gives no candidates", async () => {
		const configs = [
			"logins: [unclosed",
			"logins: not-a-list",
			"logins:\n  - name: no-url\n    token: tok\n",
			"",
		];
		for (const text of configs) {
			const teaConfigPath = await teaConfig(text);

			const result = await listCandidates(fakeEnv({ teaConfigPath }), giteaTarget("https://gitea.example.org"));

			expect(result.candidates).toEqual([]);
			expect(result.reason).toContain("tea login add");
		}
	});
});
