import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { teaLogins } from "../../src/forge/tea-config.ts";

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

const BASE_URL = "https://gitea.example.org";

async function configWith(text: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "tea-"));
	const path = join(dir, "config.yml");
	await writeFile(path, text);
	return path;
}

describe("teaLogins", () => {
	it("teaLogins lists logins without spawning tea", async () => {
		const teaConfigPath = await configWith(
			[
				"logins:",
				"  - name: gitea.example.org",
				"    url: https://gitea.example.org",
				"    token: tok-a",
				"    user: alice",
				"    ssh_host: ssh.gitea.example.org",
				"    default: true",
				"  - name: gitea-admin",
				"    url: https://gitea.example.org",
				"    token: tok-b",
				"  - name: no-url",
				"    token: tok-c",
				"  - name: no-token",
				"    url: https://gitea.example.org",
				"",
			].join("\n"),
		);

		const logins = await teaLogins({ baseUrl: BASE_URL, env: {}, teaConfigPath });

		expect(logins).toEqual([
			{ name: "gitea.example.org", url: "https://gitea.example.org", user: "alice", token: "tok-a", sshHost: "ssh.gitea.example.org" },
			{ name: "gitea-admin", url: "https://gitea.example.org", user: "", token: "tok-b" },
		]);
		expect(spawned.calls).not.toHaveBeenCalled();
	});

	it("malformed tea config gives no logins", async () => {
		const configs = [
			"logins: [unclosed\n",
			"logins: not-a-list\n",
			"logins:\n  - name: a\n    token: t\n",
			"- just\n- a list\n",
			"",
		];
		for (const text of configs) {
			const teaConfigPath = await configWith(text);
			await expect(teaLogins({ baseUrl: BASE_URL, env: {}, teaConfigPath })).resolves.toEqual([]);
		}
		await expect(teaLogins({ baseUrl: BASE_URL, env: {}, teaConfigPath: "/nonexistent/tea.yml" })).resolves.toEqual([]);
		expect(spawned.calls).not.toHaveBeenCalled();
	});
});
