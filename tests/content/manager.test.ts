import { lstat, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { readLock } from "../../src/content/lock.ts";
import { ContentManager } from "../../src/content/manager.ts";
import { createMirror } from "../../src/content/mirror.ts";
import { type ContentPaths, contentPaths } from "../../src/content/paths.ts";
import type { WorkInProgress } from "../../src/content/wip.ts";
import { type GitExec, defaultGitExec } from "../../src/engine/git-exec.ts";
import type { Pack } from "../../src/engine/pack-types.ts";
import { type Upstream, defaultPack, makeUpstream, skillFile, tempDir } from "./helpers.ts";

const HOUR_MS = 3_600_000;
const START = new Date("2026-11-14T08:00:00Z");
const IDLE: WorkInProgress = { busy: false };
const BUSY: WorkInProgress = { busy: true, change: 42, reason: "change #42 is in build with pending unit U2" };

let pack: Pack;
let dir: string;
let upstream: Upstream;
let paths: ContentPaths;
let clock: Date;
let gitCalls: string[][];

beforeAll(async () => {
	pack = await defaultPack();
});
beforeEach(async () => {
	dir = await tempDir("manager");
	upstream = await makeUpstream(dir, pack);
	paths = contentPaths(join(dir, "home"));
	clock = START;
	gitCalls = [];
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const recordingExec: GitExec = (args, opts) => {
	gitCalls.push(args);
	return defaultGitExec(args, opts);
};

function manager(source = upstream.url): ContentManager {
	return new ContentManager({ paths, mirror: createMirror(paths, recordingExec), now: () => clock, source });
}
const advance = (hours: number) => {
	clock = new Date(clock.getTime() + hours * HOUR_MS);
};
const fetches = () => gitCalls.filter((a) => a.includes("fetch")).length;
const currentSha = async () => (await readlink(paths.current)).split("/").pop();
const lock = async () => {
	const l = await readLock(paths.lock);
	if (!l) throw new Error("no lock");
	return l;
};
const head = async () => (await defaultGitExec(["--git-dir", upstream.url, "rev-parse", "HEAD"])).stdout.trim();

async function cloned(): Promise<{ m: ContentManager; first: string }> {
	const m = manager();
	const r = await m.clone(pack);
	if (r.kind !== "installed") throw new Error(`clone failed: ${JSON.stringify(r)}`);
	return { m, first: r.sha };
}

const CHANGED_INTERVIEW = { "skills/interview-me/SKILL.md": skillFile("interview-me", "Use for interview-me.", "New body.\n") };
const REMOVED_INTERVIEW = { "skills/interview-me": null };

describe("clone", () => {
	test("First clone", async () => {
		const sha = await head();
		const r = await manager().clone(pack);
		expect(r).toEqual({ kind: "installed", sha });
		expect(await readFile(join(paths.tree(sha), "skills", "interview-me", "SKILL.md"), "utf8")).toBe(skillFile("interview-me"));
		expect((await lstat(paths.current)).isSymbolicLink()).toBe(true);
		expect(await realpath(paths.current)).toBe(await realpath(paths.tree(sha)));
		expect(await lock()).toEqual({ source: upstream.url, commit: sha, pinned: null, history: [sha], skipped: [], checkedAt: START.toISOString() });
	});

	test("Clone fails", async () => {
		const bad = join(dir, "missing.git");
		const r = await manager(bad).clone(pack);
		expect(r.kind).toBe("failed");
		if (r.kind === "failed") expect(r.reason).toContain(bad);
		await expect(lstat(paths.current)).rejects.toThrow();
	});

	test("clone returns exists when current is present", async () => {
		const { first } = await cloned();
		gitCalls = [];
		expect(await manager().clone(pack)).toEqual({ kind: "exists", sha: first });
		expect(gitCalls).toEqual([]);
	});

	test("first clone of an incompatible upstream fails with the items", async () => {
		await upstream.commit(REMOVED_INTERVIEW);
		const r = await manager().clone(pack);
		expect(r.kind).toBe("failed");
		if (r.kind === "failed") expect(r.failures?.map((f) => f.item)).toEqual(["interview-me"]);
		await expect(lstat(paths.current)).rejects.toThrow();
		expect((await readdir(paths.root)).filter((n) => n.startsWith(".staging"))).toEqual([]);
	});

	test("checkout leaves the mirror index untouched", async () => {
		await cloned();
		await expect(lstat(join(paths.mirror, "index"))).rejects.toThrow();
		const tmpIndexes = (await readdir(paths.root)).filter((n) => n.includes("index"));
		expect(tmpIndexes).toEqual([]);
	});
});

describe("automatic upgrade", () => {
	test("Compatible upgrade", async () => {
		const { m, first } = await cloned();
		const next = await upstream.commit(CHANGED_INTERVIEW);
		advance(25);
		const r = await m.autoCheck(pack, "auto", IDLE);
		expect(r).toEqual({ kind: "installed", sha: next, changed: { added: [], removed: [], changed: ["interview-me"] } });
		expect(await currentSha()).toBe(next);
		const l = await lock();
		expect(l.commit).toBe(next);
		expect(l.history).toEqual([first, next]);
		expect(l.checkedAt).toBe(clock.toISOString());
	});

	test("Incompatible upgrade", async () => {
		const { m, first } = await cloned();
		const before = await lock();
		await upstream.commit(REMOVED_INTERVIEW);
		advance(25);
		const r = await m.autoCheck(pack, "auto", IDLE);
		expect(r.kind).toBe("failed");
		if (r.kind === "failed") expect(r.failures?.map((f) => f.item)).toContain("interview-me");
		expect(await currentSha()).toBe(first);
		expect(await lock()).toEqual({ ...before, checkedAt: clock.toISOString() });
		expect((await readdir(paths.root)).filter((n) => n.startsWith(".staging"))).toEqual([]);
	});

	test("Failed check throttles too", async () => {
		const { m } = await cloned();
		await upstream.commit(REMOVED_INTERVIEW);
		advance(25);
		expect((await m.autoCheck(pack, "auto", IDLE)).kind).toBe("failed");
		advance(1);
		gitCalls = [];
		expect((await m.autoCheck(pack, "auto", IDLE)).kind).toBe("skipped");
		expect(fetches()).toBe(0);
	});

	test("Throttled", async () => {
		const { m } = await cloned();
		await upstream.commit(CHANGED_INTERVIEW);
		advance(1);
		gitCalls = [];
		expect((await m.autoCheck(pack, "auto", IDLE)).kind).toBe("skipped");
		expect(fetches()).toBe(0);
	});

	test("Notify channel", async () => {
		const { m, first } = await cloned();
		const next = await upstream.commit(CHANGED_INTERVIEW);
		advance(25);
		expect(await m.autoCheck(pack, "notify", IDLE)).toEqual({ kind: "notified", sha: next });
		expect(await currentSha()).toBe(first);
		expect((await lock()).checkedAt).toBe(clock.toISOString());
	});

	test("Build in progress", async () => {
		const { m, first } = await cloned();
		await upstream.commit(CHANGED_INTERVIEW);
		advance(25);
		const r = await m.autoCheck(pack, "auto", BUSY);
		expect(r.kind).toBe("skipped");
		if (r.kind === "skipped") expect(r.reason).toContain("#42");
		expect(await currentSha()).toBe(first);
	});

	test("upgrade lists added and removed pack skills", async () => {
		const { m } = await cloned();
		const narrowed: Pack = { ...pack, init: { skills: [] } };
		await upstream.commit(CHANGED_INTERVIEW);
		advance(25);
		const r = await m.autoCheck(narrowed, "auto", IDLE);
		expect(r.kind).toBe("installed");
		if (r.kind === "installed") expect(r.changed).toEqual({ added: [], removed: [], changed: ["interview-me"] });
	});
});

describe("skills commands", () => {
	test("Manual update", async () => {
		const { m } = await cloned();
		const next = await upstream.commit(CHANGED_INTERVIEW);
		advance(1);
		const r = await m.update(pack, IDLE);
		expect(r.kind).toBe("installed");
		expect(await currentSha()).toBe(next);
	});

	test("Manual update refused in build", async () => {
		const { m, first } = await cloned();
		const older = first;
		const next = await upstream.commit(CHANGED_INTERVIEW);
		const before = await lock();
		const u = await m.update(pack, BUSY);
		expect(u.kind).toBe("refused");
		if (u.kind === "refused") expect(u.reason).toContain("#42");
		const p = await m.pin(next, pack, BUSY);
		expect(p.kind).toBe("refused");
		if (p.kind === "refused") expect(p.reason).toContain("#42");
		expect(await currentSha()).toBe(older);
		expect(await lock()).toEqual(before);
	});

	test("Rollback allowed in build", async () => {
		const { m, first } = await cloned();
		advance(25);
		const next = await upstream.commit(CHANGED_INTERVIEW);
		await m.autoCheck(pack, "auto", IDLE);
		const r = await m.rollback();
		expect(r.kind).toBe("installed");
		expect(await currentSha()).toBe(first);
		expect((await lock()).skipped).toEqual([next]);
	});

	test("Rollback", async () => {
		const { m, first } = await cloned();
		const b = await upstream.commit(CHANGED_INTERVIEW);
		await m.update(pack, IDLE);
		const r = await m.rollback();
		expect(r).toEqual({ kind: "installed", sha: first, changed: { added: [], removed: [], changed: ["interview-me"] } });
		expect(await currentSha()).toBe(first);
		const l = await lock();
		expect(l.commit).toBe(first);
		expect(l.skipped).toEqual([b]);
		expect(l.history).toEqual([first]);
	});

	test("rollback with no previous commit is refused", async () => {
		const { m } = await cloned();
		expect((await m.rollback()).kind).toBe("refused");
	});

	test("Skipped commit not reinstalled", async () => {
		const { m, first } = await cloned();
		await upstream.commit(CHANGED_INTERVIEW);
		await m.update(pack, IDLE);
		await m.rollback();
		advance(25);
		expect((await m.autoCheck(pack, "auto", IDLE)).kind).toBe("skipped");
		expect(await currentSha()).toBe(first);
		const newer = await upstream.commit({ "README.md": "newer\n" });
		advance(25);
		expect(await m.autoCheck(pack, "auto", IDLE)).toMatchObject({ kind: "installed", sha: newer });
	});

	test("Pin", async () => {
		const { m, first } = await cloned();
		await upstream.commit(CHANGED_INTERVIEW);
		await m.update(pack, IDLE);
		const r = await m.pin(first, pack, IDLE);
		expect(r).toMatchObject({ kind: "installed", sha: first });
		expect(await currentSha()).toBe(first);
		expect((await lock()).pinned).toBe(first);
		await upstream.commit({ "README.md": "newer\n" });
		advance(25);
		expect((await m.autoCheck(pack, "auto", IDLE)).kind).toBe("skipped");
		expect(await currentSha()).toBe(first);
	});

	test("pin accepts an abbreviated sha and records the full one", async () => {
		const { m, first } = await cloned();
		await upstream.commit(CHANGED_INTERVIEW);
		await m.update(pack, IDLE);
		expect(await m.pin(first.slice(0, 8), pack, IDLE)).toMatchObject({ kind: "installed", sha: first });
		expect((await lock()).pinned).toBe(first);
	});

	test("pin of an unknown or option-like ref fails without changes", async () => {
		const { m } = await cloned();
		const before = await lock();
		expect((await m.pin("--output=/tmp/x", pack, IDLE)).kind).toBe("failed");
		expect((await m.pin("f".repeat(40), pack, IDLE)).kind).toBe("failed");
		expect(await lock()).toEqual(before);
	});

	test("Pin incompatible commit", async () => {
		const { m, first } = await cloned();
		const bad = await upstream.commit(REMOVED_INTERVIEW);
		const before = await lock();
		const r = await m.pin(bad, pack, IDLE);
		expect(r.kind).toBe("failed");
		if (r.kind === "failed") expect(r.failures?.map((f) => f.item)).toContain("interview-me");
		expect(await currentSha()).toBe(first);
		expect(await lock()).toEqual(before);
	});

	test("Unpin", async () => {
		const { m, first } = await cloned();
		await m.pin(first, pack, IDLE);
		await m.unpin();
		const l = await lock();
		expect(l.pinned).toBeNull();
		expect(l.commit).toBe(first);
		expect(await currentSha()).toBe(first);
	});

	test("Update while pinned", async () => {
		const { m, first } = await cloned();
		await m.pin(first, pack, IDLE);
		await upstream.commit(CHANGED_INTERVIEW);
		const r = await m.update(pack, IDLE);
		expect(r.kind).toBe("refused");
		if (r.kind === "refused") expect(r.reason).toMatch(/unpin/);
		expect(await currentSha()).toBe(first);
	});

	test("Status", async () => {
		const { m, first } = await cloned();
		await m.pin(first, pack, IDLE);
		const out = await m.status("auto");
		expect(out).toContain(`Active commit: ${first}`);
		expect(out).toContain(`Pinned: ${first}`);
		expect(out).toContain("Channel: auto");
		expect(out).toContain(`Last check: ${START.toISOString()}`);
		expect(out).toContain(`Kept commits: ${first}`);
	});

	test("status before any clone says so", async () => {
		expect(await manager().status("auto")).toContain("not cloned");
	});

	test("keeps the last 5 trees", async () => {
		const { m, first } = await cloned();
		const shas = [first];
		for (let i = 0; i < 6; i++) {
			shas.push(await upstream.commit({ "README.md": `rev ${i}\n` }));
			expect((await m.update(pack, IDLE)).kind).toBe("installed");
		}
		const trees = (await readdir(paths.root)).filter((n) => /^[0-9a-f]{40}$/.test(n)).sort();
		expect(trees).toEqual(shas.slice(-5).sort());
		expect((await lock()).history).toEqual(shas.slice(-5));
	});

	test("activeTree is the real sha path", async () => {
		const { m, first } = await cloned();
		expect(await m.activeTree()).toBe(await realpath(paths.tree(first)));
		expect(await manager().activeTree()).toBe(await realpath(paths.tree(first)));
	});

	test("activeTree is undefined without a clone", async () => {
		expect(await manager().activeTree()).toBeUndefined();
	});
});
