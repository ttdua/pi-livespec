import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { adapterChain, loadConfig } from "../src/config.ts";

let root: string;
let home: string;

function put(base: string, rel: string, text: string): void {
	const file = join(base, rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}
const projectFile = (text: string) => put(root, ".pi/livespec/config.yaml", text);
const userFile = (text: string) => put(home, ".pi/agent/livespec/config.yaml", text);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ls-cfg-root-"));
	home = mkdtempSync(join(tmpdir(), "ls-cfg-home-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

describe("loadConfig", () => {
	test("Unknown key", async () => {
		projectFile("forge: github\nintegrationBrnach: main\n");
		const { project, warnings } = await loadConfig(root, home);
		expect(project?.forge).toBe("github");
		expect(warnings.some((w) => w.includes("integrationBrnach"))).toBe(true);
	});

	test("missing project file means not initialized", async () => {
		const { project } = await loadConfig(root, home);
		expect(project).toBeNull();
	});

	test("empty project file is initialized with defaults", async () => {
		projectFile("");
		const { project, warnings } = await loadConfig(root, home);
		expect(project).toEqual({ githubHosts: [], agentSkillsChannelSet: false });
		expect(warnings).toEqual([]);
	});

	test("reads all project keys", async () => {
		projectFile(
			"forge: gitea\nhost: g.example\ngithubHosts: [a.example]\ngiteaUrl: https://g.example\nintegrationBranch: dev\n",
		);
		const { project } = await loadConfig(root, home);
		expect(project).toEqual({
			forge: "gitea",
			host: "g.example",
			githubHosts: ["a.example"],
			giteaUrl: "https://g.example",
			integrationBranch: "dev",
			agentSkillsChannelSet: false,
		});
	});

	test("Default channel", async () => {
		const { user } = await loadConfig(root, home);
		expect(user.agentSkills.channel).toBe("auto");
	});

	test("user channel is read", async () => {
		userFile("agentSkills:\n  channel: pinned\n");
		const { user, warnings } = await loadConfig(root, home);
		expect(user.agentSkills.channel).toBe("pinned");
		expect(warnings).toEqual([]);
	});

	test("invalid channel value is a warning and falls back to auto", async () => {
		userFile("agentSkills:\n  channel: sometimes\n");
		const { user, warnings } = await loadConfig(root, home);
		expect(user.agentSkills.channel).toBe("auto");
		expect(warnings.some((w) => w.includes("sometimes"))).toBe(true);
	});

	test("channel value with an own toString key is a warning, not a throw", async () => {
		userFile("agentSkills: { channel: { toString: invalid } }\n");
		const { user, warnings } = await loadConfig(root, home);
		expect(user.agentSkills.channel).toBe("auto");
		expect(warnings.some((w) => w.includes("agentSkills.channel"))).toBe(true);
	});

	test("forge value with an own toString key is a warning, not a throw", async () => {
		projectFile("forge: { toString: invalid }\n");
		const { project, warnings } = await loadConfig(root, home);
		expect(project?.forge).toBeUndefined();
		expect(warnings.some((w) => w.includes("forge"))).toBe(true);
	});

	test("project agentSkills.channel is flagged", async () => {
		projectFile("agentSkills:\n  channel: notify\n");
		const { project, user } = await loadConfig(root, home);
		expect(project?.agentSkillsChannelSet).toBe(true);
		expect(user.agentSkills.channel).toBe("auto");
	});

	test("invalid YAML warns with the file and uses defaults", async () => {
		projectFile("forge: [unclosed\n");
		userFile("agentSkills: {channel\n");
		const { project, user, warnings } = await loadConfig(root, home);
		expect(project).toEqual({ githubHosts: [], agentSkillsChannelSet: false });
		expect(user.agentSkills.channel).toBe("auto");
		expect(warnings.some((w) => w.includes(join(root, ".pi/livespec/config.yaml")))).toBe(true);
		expect(warnings.some((w) => w.includes(join(home, ".pi/agent/livespec/config.yaml")))).toBe(true);
	});

	test("unknown user key warns", async () => {
		userFile("bogus: 1\n");
		const { warnings } = await loadConfig(root, home);
		expect(warnings.some((w) => w.includes("bogus"))).toBe(true);
	});

	test("Interaction adapter list", async () => {
		projectFile("interaction: { adapter: [forge, in-session] }\n");
		const config = await loadConfig(root, home);
		expect(config.project?.interaction).toEqual({ adapter: ["forge", "in-session"] });
		expect(adapterChain(config)).toEqual({ chain: ["forge", "in-session"], source: "project" });
		expect(config.warnings).toEqual([]);
	});

	test("Unknown adapter name", async () => {
		userFile("interaction: { adapter: [plannotator] }\n");
		const config = await loadConfig(root, home);
		expect(config.warnings.some((w) => w.includes("plannotator") && w.includes("unknown adapter"))).toBe(true);
		expect(adapterChain(config)).toEqual({ chain: ["in-session"], source: "default" });
	});

	test("interaction adapter must be a list", async () => {
		projectFile("interaction: { adapter: forge }\n");
		userFile("interaction: [forge]\n");
		const config = await loadConfig(root, home);
		expect(config.project?.interaction).toBeUndefined();
		expect(config.user.interaction).toBeUndefined();
		expect(config.warnings.some((w) => w.includes("interaction.adapter") && w.includes("list"))).toBe(true);
		expect(config.warnings.some((w) => w.includes('"interaction" must be a mapping'))).toBe(true);
		expect(adapterChain(config).chain).toEqual(["in-session"]);
	});

	test("unknown interaction key warns", async () => {
		userFile("interaction: { adapter: [forge], timeout: 3 }\n");
		const config = await loadConfig(root, home);
		expect(config.warnings.some((w) => w.includes("interaction.timeout"))).toBe(true);
		expect(config.user.interaction).toEqual({ adapter: ["forge"] });
	});

	test("project chain wins over user chain", async () => {
		projectFile("interaction: { adapter: [forge] }\n");
		userFile("interaction: { adapter: [in-session, forge] }\n");
		const config = await loadConfig(root, home);
		expect(adapterChain(config)).toEqual({ chain: ["forge"], source: "project" });
	});

	test("Project list with only unknown names", async () => {
		projectFile("interaction: { adapter: [slack] }\n");
		userFile("interaction: { adapter: [forge] }\n");
		const config = await loadConfig(root, home);
		expect(config.warnings.some((w) => w.includes("slack"))).toBe(true);
		expect(adapterChain(config)).toEqual({ chain: ["forge"], source: "user" });
	});

	test("Empty project list", async () => {
		projectFile("interaction: { adapter: [] }\n");
		userFile("interaction: { adapter: [forge] }\n");
		const config = await loadConfig(root, home);
		expect(adapterChain(config)).toEqual({ chain: ["forge"], source: "user" });
	});

	test("Every list empty", async () => {
		projectFile("interaction: { adapter: [] }\n");
		userFile("interaction: { adapter: [] }\n");
		const config = await loadConfig(root, home);
		expect(adapterChain(config)).toEqual({ chain: ["in-session"], source: "default" });
	});

	test("user chain is used without a project chain", async () => {
		projectFile("forge: github\n");
		userFile("interaction: { adapter: [in-session, forge] }\n");
		const config = await loadConfig(root, home);
		expect(adapterChain(config)).toEqual({ chain: ["in-session", "forge"], source: "user" });
	});

	test("empty adapter list falls back to the default", async () => {
		projectFile("interaction: { adapter: [] }\n");
		const config = await loadConfig(root, home);
		expect(adapterChain(config)).toEqual({ chain: ["in-session"], source: "default" });
	});
});

describe("verify config", () => {
	test("Verify settings", async () => {
		projectFile('verify: { setup: "bun install --frozen-lockfile", timeout: 120 }\n');
		const { project, warnings } = await loadConfig(root, home);
		expect(project?.verify).toEqual({ setup: "bun install --frozen-lockfile", timeoutS: 120 });
		expect(warnings).toEqual([]);
	});

	test("Invalid verify timeout", async () => {
		projectFile("verify: { timeout: -5 }\n");
		const { project, warnings } = await loadConfig(root, home);
		expect(project?.verify).toEqual({ timeoutS: 600 });
		expect(warnings.some((w) => w.includes("verify.timeout"))).toBe(true);
	});

	test("a non-integer verify timeout warns and uses the default", async () => {
		projectFile("verify: { timeout: 1.5 }\n");
		const { project, warnings } = await loadConfig(root, home);
		expect(project?.verify).toEqual({ timeoutS: 600 });
		expect(warnings.some((w) => w.includes("verify.timeout"))).toBe(true);
	});

	test("a non-string verify setup warns and is ignored", async () => {
		projectFile("verify: { setup: [a, b] }\n");
		const { project, warnings } = await loadConfig(root, home);
		expect(project?.verify).toEqual({ timeoutS: 600 });
		expect(warnings.some((w) => w.includes("verify.setup"))).toBe(true);
	});

	test("verify must be a mapping and unknown verify keys warn", async () => {
		projectFile("verify: 5\n");
		const first = await loadConfig(root, home);
		expect(first.project?.verify).toBeUndefined();
		expect(first.warnings.some((w) => w.includes('"verify"'))).toBe(true);
		projectFile("verify: { timout: 3 }\n");
		const second = await loadConfig(root, home);
		expect(second.project?.verify).toEqual({ timeoutS: 600 });
		expect(second.warnings.some((w) => w.includes("verify.timout"))).toBe(true);
	});

	test("verify is absent when not set", async () => {
		projectFile("forge: github\n");
		const { project } = await loadConfig(root, home);
		expect(project?.verify).toBeUndefined();
	});
});
