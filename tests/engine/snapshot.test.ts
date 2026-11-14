import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CommentsCache } from "../../src/engine/comments-cache.ts";
import { createGit } from "../../src/engine/git.ts";
import { readChangeSnapshot, type SnapshotDeps } from "../../src/engine/snapshot.ts";
import { CachedForge } from "../../src/forge/cache.ts";
import { writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { FIXTURE_BODY } from "../helpers/change-state.ts";
import { commitAll, makeRepo, writeIn } from "../helpers/repo.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN, OTHER_LOGIN } from "../forge/world.ts";

const BUILD_LABELS = ["livespec", "livespec:phase/build"];

let dir: string;
let world: MemoryWorld;
let root: string;
let base: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ls-snapshot-"));
	world = new MemoryWorld();
	root = await makeRepo();
	await writeIn(root, "README.md", "x\n");
	commitAll(root);
	base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function deps(forge: Forge = world.forge, isReadOnly = () => false): SnapshotDeps {
	return { forge, isReadOnly, git: createGit(root), comments: new CommentsCache({ dir: join(dir, "comments") }) };
}

function withBase(body: string, sha: string | undefined): string {
	return sha === undefined ? body.replace(/^Base: .*\n/m, "") : body.replace(/^Base: .*$/m, `Base: ${sha}`);
}

describe("readChangeSnapshot", () => {
	test("State from fixture issue", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: FIXTURE_BODY, labels: BUILD_LABELS });
		await writeIn(root, "dirty.txt", "y\n");
		const state = await readChangeSnapshot(deps(), n);
		expect(state.phase).toEqual({ kind: "ok", id: "build" });
		expect(state.change.units.map((u) => [u.id, u.done])).toEqual([
			["U1", true],
			["U3", false],
		]);
		expect(state.git.dirty).toBe(true);
		expect(state.issue).toEqual({ number: n, title: "per-ip-cap", labels: BUILD_LABELS });
		expect(state.sections).toEqual({ Capabilities: true, Proposal: true, Design: true, Units: true });
		expect(state.stale).toBe(false);
		expect(state.readOnly).toBe(false);
	});

	test("Stale state", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: FIXTURE_BODY, labels: BUILD_LABELS });
		await world.postComment(n, BOT_LOGIN, writeMarked("counter", "review_rounds", { value: 2 }));
		const forge = new CachedForge(world.forge, { cacheRoot: join(dir, "issues"), host: "h", owner: "o", repo: "r" });
		const d = deps(forge, () => forge.isReadOnly());
		await readChangeSnapshot(d, n);
		await world.makeUnreachable();
		const state = await readChangeSnapshot(d, n);
		expect(state.stale).toBe(true);
		expect(state.readOnly).toBe(true);
		expect(state.phase).toEqual({ kind: "ok", id: "build" });
		expect(state.change.units).toHaveLength(2);
	});

	test("offline with no known login reads no own comments and warns", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: withBase(FIXTURE_BODY, base), labels: BUILD_LABELS });
		await world.postComment(n, BOT_LOGIN, writeMarked("counter", "review_rounds", { value: 2 }));
		const warm = new CachedForge(world.forge, { cacheRoot: join(dir, "issues"), host: "h", owner: "o", repo: "r" });
		const comments = new CommentsCache({ dir: join(dir, "comments") });
		await readChangeSnapshot({ ...deps(warm), comments }, n);
		await world.makeUnreachable();
		// A new forge instance (new session) has never seen the login.
		const fresh = new CachedForge(world.forge, { cacheRoot: join(dir, "issues"), host: "h", owner: "o", repo: "r" });
		const state = await readChangeSnapshot({ ...deps(fresh, () => fresh.isReadOnly()), comments }, n);
		expect(state.stale).toBe(true);
		expect(state.counters).toEqual({});
		expect(state.warnings).toEqual([expect.stringContaining("login is unknown")]);
	});

	test("Ambiguous phase", async () => {
		const labels = ["livespec", "livespec:phase/define", "livespec:phase/plan"];
		const n = await world.seedIssue({ title: "per-ip-cap", body: FIXTURE_BODY, labels });
		const state = await readChangeSnapshot(deps(), n);
		expect(state.phase).toEqual({ kind: "ambiguous", ids: ["define", "plan"] });
	});

	test("missing phase label", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: FIXTURE_BODY, labels: ["livespec"] });
		expect((await readChangeSnapshot(deps(), n)).phase).toEqual({ kind: "missing" });
	});

	test("incomplete markers are collected", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: withBase(FIXTURE_BODY, base), labels: BUILD_LABELS });
		await world.postComment(n, BOT_LOGIN, writeMarked("incomplete", "U3", { reason: "stopped" }));
		await world.postComment(n, BOT_LOGIN, writeMarked("skill-note", "build.debugging-and-error-recovery", { phase: "build", skill: "debugging-and-error-recovery", reason: "r" }));
		await world.postComment(n, BOT_LOGIN, writeMarked("counter", "review_rounds", { value: 2 }));
		await world.postComment(n, OTHER_LOGIN, writeMarked("incomplete", "U1", { reason: "foreign" }));
		const state = await readChangeSnapshot(deps(), n);
		expect(state.incomplete).toEqual(["U3"]);
		expect(state.skillNotes).toEqual(["build.debugging-and-error-recovery"]);
		expect(state.counters).toEqual({ review_rounds: 2 });
		expect(state.warnings).toEqual([expect.stringContaining(`written by ${OTHER_LOGIN}`)]);
	});

	test("specsChanged reflects the diff from Base", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: withBase(FIXTURE_BODY, base), labels: BUILD_LABELS });
		expect((await readChangeSnapshot(deps(), n)).git.specsChanged).toBe(false);
		await writeIn(root, "specs/rate-limit/spec.md", "# rate-limit\n");
		commitAll(root, "spec");
		const state = await readChangeSnapshot(deps(), n);
		expect(state.git.specsChanged).toBe(true);
		expect(state.git.head).not.toBe(base);
		expect(state.git.branch).not.toBe("");
	});

	test("specsChanged is undefined without Base", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: withBase(FIXTURE_BODY, undefined), labels: BUILD_LABELS });
		const state = await readChangeSnapshot(deps(), n);
		expect(state.git.specsChanged).toBeUndefined();
		expect(state.warnings).toEqual([]);
	});

	test("unknown Base leaves specsChanged undefined with a warning", async () => {
		const n = await world.seedIssue({ title: "per-ip-cap", body: FIXTURE_BODY, labels: BUILD_LABELS });
		const state = await readChangeSnapshot(deps(), n);
		expect(state.git.specsChanged).toBeUndefined();
		expect(state.warnings).toEqual([expect.stringContaining("0123456789abcdef0123456789abcdef01234567")]);
	});

	test("sections are absent when empty or undeclared", async () => {
		const body = "Capabilities: new [], modified []\n\n## Proposal\n\n## Design\nSomething.\n\n## Units\n";
		const n = await world.seedIssue({ title: "x", body, labels: ["livespec", "livespec:phase/define"] });
		const state = await readChangeSnapshot(deps(), n);
		expect(state.sections).toEqual({ Capabilities: false, Proposal: false, Design: true, Units: false });
	});
});
