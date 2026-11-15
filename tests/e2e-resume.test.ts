// End to end: the real extension default export over a fake pi, a memory forge
// and a pre-installed agent-skills tree. A new session opened mid-change shows
// the correct next step on the resume card and on the phase card.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeLock } from "../src/content/lock.ts";
import { contentPaths } from "../src/content/paths.ts";
import extension from "../src/extension.ts";
import { getSession, setSession } from "../src/hooks/session-store.ts";
import { defaultPack, validTreeFiles, writeTree } from "./content/helpers.ts";
import { MemoryWorld } from "./forge/memory-forge.ts";
import { FakePi, fakeCtx } from "./hooks/fake-pi.ts";
import { BUILD_LABELS, CHANGE_BRANCH, ORIGIN, blockNetwork, cardText, promptEvent, resumeBody } from "./hooks/helpers.ts";
import { FIXTURE_BODY } from "./helpers/change-state.ts";
import { commitAll, makeRepo, writeIn } from "./helpers/repo.ts";

const TREE_SHA = "b".repeat(40);
const homes: string[] = [];

afterEach(async () => {
	await getSession()?.upgrade;
	setSession(undefined);
	for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A home with an installed agent-skills tree whose last check is now, so the background check is throttled. */
async function homeWithSkills(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "ls-e2e-home-"));
	homes.push(home);
	const paths = contentPaths(home);
	await writeTree(paths.tree(TREE_SHA), validTreeFiles(await defaultPack()));
	await symlink(TREE_SHA, paths.current);
	await writeLock(paths.lock, {
		source: "file:///upstream.git",
		commit: TREE_SHA,
		pinned: null,
		history: [TREE_SHA],
		skipped: [],
		checkedAt: new Date().toISOString(),
	});
	return home;
}

/** An initialized repo with `origin`, switched to the change branch; returns the root and its HEAD. */
async function changeRepo(): Promise<{ root: string; head: string }> {
	const root = await makeRepo();
	await writeIn(root, "README.md", "x\n");
	await writeIn(root, ".pi/livespec/config.yaml", "integrationBranch: main\n");
	commitAll(root);
	execFileSync("git", ["branch", "-M", "main"], { cwd: root });
	execFileSync("git", ["remote", "add", "origin", ORIGIN], { cwd: root });
	blockNetwork(root);
	execFileSync("git", ["switch", "-q", "-c", CHANGE_BRANCH], { cwd: root });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	return { root, head };
}

/** Loads the real extension with the memory forge, seeds the change issue and opens a session. */
async function resumeWith(body: (head: string) => string) {
	const { root, head } = await changeRepo();
	const home = await homeWithSkills();
	const world = new MemoryWorld();
	const n = await world.seedIssue({ title: "per-ip-cap", body: body(head), labels: BUILD_LABELS });
	const pi = new FakePi();
	extension(pi.api as never, { home, detect: async () => world.forge });
	const ctx = fakeCtx(root);
	await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
	const prompt = promptEvent();
	await pi.fire("before_agent_start", prompt, ctx);
	const card = await cardText(pi, ctx);
	const resume = pi.entries.filter((e) => e.customType === "livespec-resume").map((e) => (e.data as { text: string }).text);
	return { n, card, resume, prompt, pi, ctx, home };
}

describe("resume through the extension", () => {
	test("Resume mid-change", async () => {
		const r = await resumeWith(resumeBody);
		expect(r.resume).toHaveLength(1);
		for (const text of [r.resume[0]!, r.card]) {
			expect(text).toContain(`#${r.n}`);
			expect(text).toContain("build");
			expect(text).toContain("Build U3 — Rate limit per IP.");
		}
		expect(r.prompt.systemPromptOptions.sections.livespec).toBeDefined();
		const skills = (await r.pi.fire("resources_discover", { type: "resources_discover" }, r.ctx)) as { skillPaths: string[] };
		expect(skills.skillPaths.length).toBeGreaterThan(0);
		for (const path of skills.skillPaths) expect(path).toContain(TREE_SHA);
	});

	test("the change repo cannot reach its origin", async () => {
		const { root } = await changeRepo();
		const r = spawnSync("git", ["fetch", "origin"], { cwd: root, encoding: "utf8", timeout: 10_000 });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(/transport 'https' not allowed/);
	});

	test("unanswered blocking question wins on resume", async () => {
		const r = await resumeWith((head) => FIXTURE_BODY.replace(/^Base: .*$/m, `Base: ${head}`));
		expect(r.resume[0]).toContain("Answer blocking question Q1 before continuing.");
		expect(r.card).toContain("Answer blocking question Q1 before continuing.");
		expect(r.card).not.toContain("Build U3");
	});
});
