// A check source's version is a content hash of the check, so it changes with the check state only.
import { expect, test } from "vitest";
import { pullRequestAndChecks } from "../../src/subagents/sources-forge.ts";
import type { Cx } from "../../src/subagents/source-kit.ts";

type Check = { name: string; state: string; url?: string };

async function checkVersion(check: Check): Promise<string> {
	const cx = {
		ctx: {
			state: { change: { header: { pr: "#9" } } },
			git: { head: async () => "h".repeat(40) },
			forge: {
				getPullRequest: async () => ({ title: "t", body: "b", version: "p1" }),
				getChecks: async () => ({ state: "none", checks: [check] }),
			},
		},
	} as unknown as Cx;
	const out = await pullRequestAndChecks.run(cx);
	const found = out.find((p) => p.source.id.startsWith("check:"));
	if (found === undefined) throw new Error("no check source");
	return found.source.version;
}

test("check version is stable for the same check and changes with its state", async () => {
	const base = { name: "ci", state: "pending", url: "http://x" };
	const first = await checkVersion(base);
	expect(first).toMatch(/^[0-9a-f]{64}$/);
	expect(await checkVersion({ ...base })).toBe(first);
	expect(await checkVersion({ ...base, state: "success" })).not.toBe(first);
});
