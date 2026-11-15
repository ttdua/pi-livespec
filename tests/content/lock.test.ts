import { readdir, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Lock, readLock, writeLock } from "../../src/content/lock.ts";
import { contentPaths } from "../../src/content/paths.ts";
import { switchCurrent } from "../../src/content/tree.ts";
import { tempDir } from "./helpers.ts";

let dir: string;
beforeEach(async () => {
	dir = await tempDir("lock");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const sha = (c: string) => c.repeat(40);
const lockFor = (commit: string): Lock => ({ source: "s", commit, pinned: null, history: [commit], skipped: [], checkedAt: null });

describe("temp files", () => {
	test("concurrent lock writes never collide on the temp file", async () => {
		const path = join(dir, "livespec.lock");
		const commits = [..."0123456789"].map(sha);
		await Promise.all(commits.map((c) => writeLock(path, lockFor(c))));
		expect(commits).toContain((await readLock(path))?.commit);
		expect((await readdir(dir)).filter((n) => n.includes(".tmp"))).toEqual([]);
	});

	test("concurrent switches of current never collide on the temp link", async () => {
		const paths = contentPaths(dir);
		const { mkdir } = await import("node:fs/promises");
		await mkdir(paths.root, { recursive: true });
		const shas = [..."abcdef"].map(sha);
		await Promise.all(shas.map((s) => switchCurrent(paths, s)));
		expect(shas).toContain(await readlink(paths.current));
		expect((await readdir(paths.root)).filter((n) => n.includes(".tmp"))).toEqual([]);
	});
});
