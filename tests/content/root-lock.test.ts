import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LOCK_DIR, OWNER_FILE, STALE_LOCK_MS, withRootLock } from "../../src/content/root-lock.ts";
import { tempDir } from "./helpers.ts";

let root: string;
beforeEach(async () => {
	root = await tempDir("rootlock");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const lockDir = () => join(root, LOCK_DIR);
async function holdLock(acquiredAt: Date, pid = 999_999): Promise<void> {
	await mkdir(lockDir(), { recursive: true });
	await writeFile(join(lockDir(), OWNER_FILE), JSON.stringify({ pid, acquiredAt: acquiredAt.toISOString(), token: "other" }));
}
const exists = async (p: string) =>
	stat(p).then(
		() => true,
		() => false,
	);

describe("withRootLock", () => {
	test("runs the critical section, records the owner, and releases afterwards", async () => {
		let owner: unknown;
		const r = await withRootLock(root, "try", async () => {
			owner = JSON.parse(await readFile(join(lockDir(), OWNER_FILE), "utf8"));
			return 7;
		});
		expect(r).toEqual({ acquired: true, value: 7 });
		expect(owner).toMatchObject({ pid: process.pid });
		expect(await exists(lockDir())).toBe(false);
	});

	test("releases the lock when the critical section throws", async () => {
		await expect(withRootLock(root, "try", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		expect(await exists(lockDir())).toBe(false);
	});

	test("try mode does not wait for a held lock", async () => {
		await holdLock(new Date());
		let ran = false;
		const started = Date.now();
		const r = await withRootLock(root, "try", async () => {
			ran = true;
		});
		expect(r).toEqual({ acquired: false });
		expect(ran).toBe(false);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(await exists(lockDir())).toBe(true);
	});

	test("wait mode gives up after the timeout", async () => {
		await holdLock(new Date());
		const r = await withRootLock(root, "wait", async () => 1, { timeoutMs: 150, retryMs: 20 });
		expect(r).toEqual({ acquired: false });
	});

	test("wait mode acquires once the holder releases", async () => {
		await holdLock(new Date());
		setTimeout(() => void rm(lockDir(), { recursive: true, force: true }), 60);
		const r = await withRootLock(root, "wait", async () => 2, { timeoutMs: 2000, retryMs: 20 });
		expect(r).toEqual({ acquired: true, value: 2 });
	});

	test("a stale lock is taken over", async () => {
		await holdLock(new Date(Date.now() - STALE_LOCK_MS - 1000));
		const r = await withRootLock(root, "try", async () => 3);
		expect(r).toEqual({ acquired: true, value: 3 });
		expect(await exists(lockDir())).toBe(false);
	});

	test("a lock without a readable owner older than the stale limit is taken over", async () => {
		await mkdir(lockDir(), { recursive: true });
		const r = await withRootLock(root, "try", async () => 4, { now: () => Date.now() + STALE_LOCK_MS + 1000 });
		expect(r).toEqual({ acquired: true, value: 4 });
	});

	test("a fresh lock is not taken over", async () => {
		await holdLock(new Date(Date.now() - STALE_LOCK_MS + 60_000));
		expect(await withRootLock(root, "try", async () => 5)).toEqual({ acquired: false });
	});

	test("concurrent callers never overlap", async () => {
		let inside = 0;
		let maxInside = 0;
		const work = () =>
			withRootLock(
				root,
				"wait",
				async () => {
					inside += 1;
					maxInside = Math.max(maxInside, inside);
					await new Promise((r) => setTimeout(r, 15));
					inside -= 1;
				},
				{ timeoutMs: 5000, retryMs: 5 },
			);
		const results = await Promise.all([work(), work(), work(), work()]);
		expect(results.every((r) => r.acquired)).toBe(true);
		expect(maxInside).toBe(1);
	});
	test("contenders for a stale lock never overlap", async () => {
		for (let round = 0; round < 10; round++) {
			await holdLock(new Date(Date.now() - STALE_LOCK_MS - 1000));
			let inside = 0;
			let maxInside = 0;
			const work = () =>
				withRootLock(
					root,
					"wait",
					async () => {
						inside += 1;
						maxInside = Math.max(maxInside, inside);
						await new Promise((r) => setTimeout(r, 10));
						inside -= 1;
					},
					{ timeoutMs: 5000, retryMs: 2 },
				);
			const results = await Promise.all([work(), work(), work(), work(), work()]);
			expect(results.every((r) => r.acquired)).toBe(true);
			expect(maxInside).toBe(1);
		}
	});
});
