import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CommentsCache } from "../../src/engine/comments-cache.ts";
import { CachedForge } from "../../src/forge/cache.ts";
import { filterMarked, writeMarked } from "../../src/forge/markers.ts";
import type { Forge } from "../../src/forge/types.ts";
import { MemoryWorld } from "../forge/memory-forge.ts";
import { BOT_LOGIN } from "../forge/world.ts";

const MINUTE = 60_000;

let dir: string;
let clock: number;
let world: MemoryWorld;
let listCalls: number;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ls-comments-"));
	clock = 1_000_000;
	world = new MemoryWorld();
	listCalls = 0;
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** The memory forge with `listComments` counted. */
function counting(forge: Forge): Forge {
	return new Proxy(forge, {
		get(target, key, receiver) {
			if (key === "listComments") {
				return (n: number) => {
					listCalls += 1;
					return target.listComments(n);
				};
			}
			const value = Reflect.get(target, key, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function cache(): CommentsCache {
	return new CommentsCache({ dir: join(dir, "comments"), now: () => clock });
}

async function seed(): Promise<number> {
	const n = await world.seedIssue({ title: "per-ip-cap", labels: ["livespec"] });
	await world.postComment(n, BOT_LOGIN, writeMarked("stale", "review_rounds", { value: 2 }));
	return n;
}

describe("CommentsCache", () => {
	test("Comments cache hit", async () => {
		const n = await seed();
		const forge = counting(world.forge);
		const c = cache();
		await c.list(forge, await forge.getIssue(n));
		clock += 4 * MINUTE;
		const second = await c.list(forge, await forge.getIssue(n));
		expect(listCalls).toBe(1);
		expect(second.stale).toBe(false);
		expect(second.comments).toHaveLength(1);
	});

	test("entry older than 5 minutes is refetched", async () => {
		const n = await seed();
		const forge = counting(world.forge);
		const c = cache();
		await c.list(forge, await forge.getIssue(n));
		clock += 5 * MINUTE;
		await c.list(forge, await forge.getIssue(n));
		expect(listCalls).toBe(2);
	});

	test("changed updatedAt is refetched", async () => {
		const n = await seed();
		const forge = counting(world.forge);
		const c = cache();
		await c.list(forge, await forge.getIssue(n));
		await world.editBodyBehindBack(n, "changed");
		await c.list(forge, await forge.getIssue(n));
		expect(listCalls).toBe(2);
	});

	test("Account switch", async () => {
		const n = await seed();
		const forge = counting(world.forge);
		const c = cache();
		const issue = await forge.getIssue(n);
		const asA = filterMarked((await c.list(forge, issue)).comments, BOT_LOGIN);
		expect(asA.comments.map((m) => m.id)).toEqual(["review_rounds"]);
		const asB = filterMarked((await c.list(forge, issue)).comments, "other-account");
		expect(listCalls).toBe(1);
		expect(asB.comments).toEqual([]);
	});

	test("Own write invalidates", async () => {
		const n = await seed();
		const forge = counting(world.forge);
		const c = cache();
		const issue = await forge.getIssue(n);
		await c.list(forge, issue);
		await forge.createComment(n, writeMarked("skill-note", "build.debugging-and-error-recovery", { phase: "build", skill: "debugging-and-error-recovery", reason: "flaky test" }));
		await c.invalidate(n);
		const after = await c.list(forge, issue);
		expect(listCalls).toBe(2);
		expect(filterMarked(after.comments, BOT_LOGIN).comments.map((m) => m.kind)).toEqual(["stale", "skill-note"]);
	});

	test("invalidate of a missing entry is a no-op", async () => {
		await expect(cache().invalidate(99)).resolves.toBeUndefined();
	});

	test("read-only mode serves cached comments as stale", async () => {
		const n = await seed();
		const forge = new CachedForge(world.forge, { cacheRoot: join(dir, "issues"), host: "h", owner: "o", repo: "r" });
		const c = cache();
		await c.list(forge, await forge.getIssue(n));
		await world.makeUnreachable();
		const issue = await forge.getIssue(n);
		expect(issue.stale).toBe(true);
		const read = await c.list(forge, issue);
		expect(read.stale).toBe(true);
		expect(read.comments).toHaveLength(1);
	});

	test("unreachable forge without a cached entry throws", async () => {
		const n = await seed();
		const c = cache();
		const issue = await world.forge.getIssue(n);
		await world.makeUnreachable();
		await expect(c.list(world.forge, issue)).rejects.toThrow(/connection refused/);
	});

	test("corrupt cache file counts as a miss", async () => {
		const n = await seed();
		const forge = counting(world.forge);
		const c = cache();
		const issue = await forge.getIssue(n);
		await c.list(forge, issue);
		const { writeFile } = await import("node:fs/promises");
		const files = await readdir(join(dir, "comments"));
		expect(files).toEqual([`${n}.comments.json`]);
		await writeFile(join(dir, "comments", files[0] as string), "{not json");
		await c.list(forge, issue);
		expect(listCalls).toBe(2);
	});
});
