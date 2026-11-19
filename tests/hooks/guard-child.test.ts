// Guard parity and the child start path: a child blocks what the main session blocks, and never connects the forge.
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerGuardHook } from "../../src/hooks/guard.ts";
import { setSession } from "../../src/hooks/session-store.ts";
import * as poll from "../../src/interaction/poll.ts";
import { asChild } from "./fake-pi.ts";
import { BUILD_LABELS, CHANGE_BRANCH, cleanupHomes, harness, resumeBody } from "./helpers.ts";

const GITEA_HOST = "git.acme.test";
const START = { type: "session_start", reason: "startup" } as const;

afterEach(async () => {
	setSession(undefined);
	vi.restoreAllMocks();
	await cleanupHomes();
});

/**
 * A Gitea project on a host that is not github.com and that the config does not name by `giteaUrl`:
 * the guard can learn the host only from the resolved forge target, never from the config.
 */
async function giteaProject() {
	const h = await harness({ branch: CHANGE_BRANCH });
	execFileSync("git", ["remote", "set-url", "origin", `https://${GITEA_HOST}/acme/shop.git`], { cwd: h.root });
	await writeFile(join(h.root, ".pi/livespec/config.yaml"), "integrationBranch: main\nforge: gitea\n");
	await h.world.seedIssue({ title: "per-ip-cap", body: resumeBody(h.head), labels: BUILD_LABELS });
	registerGuardHook(h.pi.api as never);
	return h;
}

/** A raw curl write to the Gitea host: the guard must block it. */
const CURL_WRITE = `curl -X POST https://${GITEA_HOST}/api/v1/repos/acme/shop/issues/6/comments -d '{}'`;

/** The guard decision for CURL_WRITE after `session_start` ran as the child (true) or the main session (false). */
async function guardAfterStart(child: boolean) {
	const h = await giteaProject();
	const ctx = child ? asChild(h.ctx) : h.ctx;
	await h.pi.fire("session_start", START, ctx);
	return h.pi.fire("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "g1", input: { command: CURL_WRITE } }, ctx);
}

describe("guard parity in a child session", () => {
	test("a child blocks a curl write to the Gitea host", async () => {
		const out = (await guardAfterStart(true)) as { block: boolean; reason: string };
		expect(out?.block).toBe(true);
		expect(out.reason.startsWith("livespec guard:")).toBe(true);
	});

	test("a child and the main session give the same guard decision", async () => {
		expect(await guardAfterStart(true)).toEqual(await guardAfterStart(false));
	});

	test("a child start does not poll approvals", async () => {
		const pollSpy = vi.spyOn(poll, "pollApprovals");
		const h = await giteaProject();
		await h.pi.fire("session_start", START, asChild(h.ctx));
		expect(pollSpy).not.toHaveBeenCalled();
	});

	test("a child start does not connect the forge", async () => {
		const h = await giteaProject();
		await h.pi.fire("session_start", START, asChild(h.ctx));
		expect(h.detectCalls).toEqual([]);
	});

	test("a child start shows no resume card", async () => {
		const h = await giteaProject();
		await h.pi.fire("session_start", START, asChild(h.ctx));
		expect(h.pi.entries.filter((e) => e.customType === "livespec-resume")).toEqual([]);
	});
});
