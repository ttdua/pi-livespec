// Tests of the subagent doctor checks: executor capabilities, role overrides, workspace providers and the isolation list.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DoctorDeps, DoctorResult } from "../../src/commands/doctor.ts";
import type { LoadedConfig } from "../../src/config.ts";
import { checkSubagents } from "../../src/subagents/doctor.ts";
import { fakeExecutor, publish, unpublish } from "./fake-executor.ts";

const OVERRIDE = "/home/u/.pi/agent/agents/implementer.md";

let root: string;
let home: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ls-sdoc-root-"));
	home = mkdtempSync(join(tmpdir(), "ls-sdoc-home-"));
});
afterEach(() => {
	unpublish();
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

function config(excludePackages: string[] = []): LoadedConfig {
	return { project: null, user: { agentSkills: { channel: "auto" }, lanes: 3, packetBudgetTokens: 24000, isolation: { excludePackages } }, warnings: [] };
}

const deps = (excluded: string[] = []): DoctorDeps => ({ root, home, config: config(excluded) }) as unknown as DoctorDeps;

function userPackages(packages: unknown[]): void {
	const file = join(home, ".pi", "agent", "settings.json");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ packages }));
}

const byId = (results: DoctorResult[], id: string): DoctorResult[] => results.filter((r) => r.id === id);

describe("subagent doctor checks", () => {
	test("executor missing", async () => {
		const results = await checkSubagents(deps());
		const [executor] = byId(results, "subagent-executor");
		expect(executor?.status).toBe("warn");
		expect(executor?.message).toContain("no subagent executor");
		expect(executor?.message).toContain("livespec runs every role inline");
		expect(executor?.suggestion).toContain("pi-jev-pilot");
		expect(byId(results, "subagent-role")).toEqual([]);
	});

	test("executor lacks wait", async () => {
		const fake = fakeExecutor();
		publish({ ...fake.service, wait: undefined });
		const [executor] = byId(await checkSubagents(deps()), "subagent-executor");
		expect(executor?.status).toBe("warn");
		expect(executor?.message).toContain("missing: wait");
		expect(executor?.message).toContain("livespec runs every role inline");
	});

	test("capable executor reported with its service key", async () => {
		publish(fakeExecutor().service);
		const results = await checkSubagents(deps());
		expect(byId(results, "subagent-executor")).toEqual([{ id: "subagent-executor", status: "ok", message: expect.stringContaining("@ttdua/pi-subagents:service") }]);
		expect(byId(results, "subagent-role")).toEqual([]);
	});

	test("role override reported as information", async () => {
		const fake = fakeExecutor();
		fake.service.getAgentType = (name: string) => (name === "implementer" ? { name, source: "global", filePath: OVERRIDE } : { name, source: "builtin" });
		publish(fake.service);
		const roles = byId(await checkSubagents(deps()), "subagent-role");
		expect(roles).toEqual([{ id: "subagent-role", status: "ok", message: `implementer is overridden by ${OVERRIDE}` }]);
	});

	test("workspace provider package warns", async () => {
		userPackages(["npm:@gotgenes/pi-subagents-worktrees"]);
		const [provider] = byId(await checkSubagents(deps()), "subagent-workspace-provider");
		expect(provider?.status).toBe("warn");
		expect(provider?.message).toContain("npm:@gotgenes/pi-subagents-worktrees");
		expect(provider?.message).toContain("sequentially");
		expect(provider?.suggestion).toContain("remove");
	});

	test("no workspace provider warning without the package", async () => {
		userPackages(["npm:acme-flow"]);
		expect(byId(await checkSubagents(deps()), "subagent-workspace-provider")).toEqual([]);
	});

	test("excluded packages listed", async () => {
		userPackages(["git:github.com/obra/superpowers", "npm:acme-flow"]);
		const [excluded] = byId(await checkSubagents(deps(["npm:extra-flow"])), "subagent-isolation");
		expect(excluded).toEqual({ id: "subagent-isolation", status: "ok", message: "packages excluded from livespec children: git:github.com/obra/superpowers, npm:extra-flow" });
	});

	test("no excluded packages listed as none", async () => {
		const [excluded] = byId(await checkSubagents(deps()), "subagent-isolation");
		expect(excluded?.message).toBe("packages excluded from livespec children: none");
	});
});
