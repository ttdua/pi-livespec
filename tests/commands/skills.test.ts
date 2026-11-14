import { describe, expect, test } from "vitest";
import { type SkillsCommandDeps, runSkillsCommand } from "../../src/commands/skills.ts";
import type { Channel } from "../../src/config.ts";
import type { ContentManager, UpgradeOutcome } from "../../src/content/manager.ts";
import type { WorkInProgress } from "../../src/content/wip.ts";
import type { LoadedPack, Pack } from "../../src/engine/pack-types.ts";

const SHA = "d".repeat(40);
const USAGE = "Usage: /livespec skills <status|update|pin <sha>|unpin|rollback>";
const PACK = { name: "agent-skills" } as Pack;
const WIP: WorkInProgress = { busy: false };

type Call = [string, ...unknown[]];

function fakeManager(o: { outcome?: UpgradeOutcome; unpin?: () => Promise<void> } = {}): { content: ContentManager; calls: Call[] } {
	const calls: Call[] = [];
	const outcome = o.outcome ?? { kind: "installed", sha: SHA, changed: { added: ["a"], removed: [], changed: ["b"] } };
	const content = {
		status: async (channel: Channel) => (calls.push(["status", channel]), `Active commit: ${SHA}`),
		update: async (pack: Pack, wip: WorkInProgress) => (calls.push(["update", pack, wip]), outcome),
		pin: async (sha: string, pack: Pack, wip: WorkInProgress) => (calls.push(["pin", sha, pack, wip]), outcome),
		unpin: async () => {
			calls.push(["unpin"]);
			await o.unpin?.();
		},
		rollback: async () => (calls.push(["rollback"]), outcome),
	} as unknown as ContentManager;
	return { content, calls };
}

function deps(content: ContentManager, pack: LoadedPack = { ok: true, pack: PACK, warnings: [] }): SkillsCommandDeps {
	return { content, pack, channel: "notify", wip: async () => WIP };
}

describe("runSkillsCommand", () => {
	test("status", async () => {
		const { content, calls } = fakeManager();
		expect(await runSkillsCommand("status", deps(content))).toBe(`Active commit: ${SHA}`);
		expect(calls).toEqual([["status", "notify"]]);
	});

	test("update", async () => {
		const { content, calls } = fakeManager();
		const text = await runSkillsCommand("update", deps(content));
		expect(calls).toEqual([["update", PACK, WIP]]);
		expect(text).toContain(`installed ${SHA}`);
		expect(text).toContain("added: a");
		expect(text).toContain("changed: b");
	});

	test("pin <sha>", async () => {
		const { content, calls } = fakeManager();
		await runSkillsCommand(`  pin   ${SHA} `, deps(content));
		expect(calls).toEqual([["pin", SHA, PACK, WIP]]);
	});

	test("pin without a sha prints usage", async () => {
		const { content, calls } = fakeManager();
		expect(await runSkillsCommand("pin", deps(content))).toBe(USAGE);
		expect(calls).toEqual([]);
	});

	test("unpin", async () => {
		const { content, calls } = fakeManager();
		expect(await runSkillsCommand("unpin", deps(content))).toBe("agent-skills is no longer pinned");
		expect(calls).toEqual([["unpin"]]);
	});

	test("unpin while busy prints the error", async () => {
		const { content } = fakeManager({
			unpin: async () => {
				throw new Error("agent-skills is busy: another session is changing it; try again later");
			},
		});
		expect(await runSkillsCommand("unpin", deps(content))).toContain("busy");
	});

	test("rollback", async () => {
		const { content, calls } = fakeManager({ outcome: { kind: "refused", reason: "no previous agent-skills commit to roll back to" } });
		expect(await runSkillsCommand("rollback", deps(content))).toBe("agent-skills refused: no previous agent-skills commit to roll back to");
		expect(calls).toEqual([["rollback"]]);
	});

	test("failure lists the incompatible items", async () => {
		const outcome: UpgradeOutcome = { kind: "failed", reason: "incompatible", failures: [{ item: "idea-refine", reason: "missing" }] };
		const { content } = fakeManager({ outcome });
		expect(await runSkillsCommand("update", deps(content))).toBe("agent-skills failed: incompatible\n- idea-refine: missing");
	});

	test("update with an invalid pack is refused without calling the manager", async () => {
		const { content, calls } = fakeManager();
		const invalid: LoadedPack = { ok: false, errors: [{ severity: "error", file: "p.yaml", line: 1, col: 1, path: "phases", message: "bad" }] };
		expect(await runSkillsCommand("update", deps(content, invalid))).toContain("the flow pack is invalid");
		expect(calls).toEqual([]);
	});

	test("unknown skills subcommand prints usage", async () => {
		const { content, calls } = fakeManager();
		expect(await runSkillsCommand("frobnicate", deps(content))).toBe(USAGE);
		expect(await runSkillsCommand("", deps(content))).toBe(USAGE);
		expect(await runSkillsCommand("status extra", deps(content))).toBe(USAGE);
		expect(calls).toEqual([]);
	});
});
