import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CachedForge } from "../../src/forge/cache.ts";
import { ForgeError } from "../../src/forge/errors.ts";
import type { Forge, Version } from "../../src/forge/types.ts";
import { MemoryWorld } from "./memory-forge.ts";

const HOST = "git.example.test";
const OWNER = "acme";
const REPO = "widgets";

let cacheRoot: string;
let world: MemoryWorld;
let inner: Forge;
let forge: CachedForge;

function cachePath(n: number): string {
	return join(cacheRoot, HOST, OWNER, REPO, `${n}.json`);
}

async function readCacheFile(
	n: number,
): Promise<{ issue: { body: string }; version: Version; fetchedAt: string }> {
	return JSON.parse(await readFile(cachePath(n), "utf8"));
}

async function expectForgeError(
	promise: Promise<unknown>,
	code: string,
): Promise<ForgeError> {
	const error = await promise.then(
		() => {
			throw new Error("expected a ForgeError, but the call resolved");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ForgeError);
	expect((error as ForgeError).code).toBe(code);
	return error as ForgeError;
}

beforeEach(async () => {
	cacheRoot = await mkdtemp(join(tmpdir(), "forge-cache-"));
	world = new MemoryWorld();
	inner = world.forge;
	forge = new CachedForge(inner, {
		cacheRoot,
		host: HOST,
		owner: OWNER,
		repo: REPO,
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(cacheRoot, { recursive: true, force: true });
});

describe("CachedForge delegation", () => {
	it("takes its kind from the inner forge", () => {
		expect(forge.kind).toBe(inner.kind);
	});

	it("starts outside read-only mode", () => {
		expect(forge.isReadOnly()).toBe(false);
	});
});

describe("issue cache", () => {
	it("read writes through the issue, its version and the fetch time", async () => {
		const n = await world.seedIssue({ body: "hello" });

		const issue = await forge.getIssue(n);

		const entry = await readCacheFile(n);
		expect(entry.issue).toEqual(
			expect.objectContaining({ number: n, body: "hello" }),
		);
		expect(entry.version).toBe(issue.version);
		expect(Number.isNaN(Date.parse(entry.fetchedAt))).toBe(false);
	});

	it("refetches from the forge after the cache directory is removed", async () => {
		const n = await world.seedIssue({ body: "first" });
		await forge.getIssue(n);
		const spy = vi.spyOn(inner, "getIssue");
		await rm(cacheRoot, { recursive: true, force: true });

		const issue = await forge.getIssue(n);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(issue.body).toBe("first");
		expect(issue.stale).toBeUndefined();
		expect((await readCacheFile(n)).issue).toEqual(
			expect.objectContaining({ body: "first" }),
		);
	});
});

describe("read-only mode", () => {
	it("returns the cached issue marked stale when the forge is unreachable", async () => {
		const n = await world.seedIssue({ body: "cached body" });
		await forge.getIssue(n);
		await world.makeUnreachable();

		const issue = await forge.getIssue(n);

		expect(issue.stale).toBe(true);
		expect(issue.body).toBe("cached body");
		expect(forge.isReadOnly()).toBe(true);
	});

	it("refuses a write without calling the inner forge when read-only", async () => {
		const n = await world.seedIssue({ body: "cached" });
		const version = (await forge.getIssue(n)).version;
		await world.makeUnreachable();
		await forge.getIssue(n);
		const spy = vi.spyOn(inner, "updateIssueBody");

		const error = await expectForgeError(
			forge.updateIssueBody(n, "new body", version),
			"readonly",
		);

		expect(spy).not.toHaveBeenCalled();
		expect(error.operation).toBe("updateIssueBody");
		expect(error.message).toContain("updateIssueBody");
		expect(error.message).toMatch(/read-only/);
	});

	it("throws unreachable when the issue is not cached", async () => {
		const n = await world.seedIssue({ body: "never read" });
		await world.makeUnreachable();

		await expectForgeError(forge.getIssue(n), "unreachable");
		expect(forge.isReadOnly()).toBe(true);
	});

	it("does not start read-only mode on an HTTP 404", async () => {
		const n = await world.seedIssue({ body: "body" });
		const version = (await forge.getIssue(n)).version;

		const error = await expectForgeError(forge.getIssue(999), "http");
		expect(error.status).toBe(404);
		expect(forge.isReadOnly()).toBe(false);

		const result = await forge.updateIssueBody(n, "changed", version);
		expect(result.status).toBe("written");
	});

	it("leaves read-only mode after a later successful read", async () => {
		const n = await world.seedIssue({ body: "cached" });
		await forge.getIssue(n);
		await world.makeUnreachable();
		await forge.getIssue(n);
		expect(forge.isReadOnly()).toBe(true);

		await world.restore();
		const issue = await forge.getIssue(n);

		expect(issue.stale).toBeUndefined();
		expect(forge.isReadOnly()).toBe(false);
	});

	it("allows writes again after recovery", async () => {
		const n = await world.seedIssue({ body: "cached" });
		const version = (await forge.getIssue(n)).version;
		await world.makeUnreachable();
		await forge.getIssue(n);
		await world.restore();
		await forge.getIssue(n);

		const result = await forge.updateIssueBody(n, "after recovery", version);

		expect(result.status).toBe("written");
	});

	it("enters read-only mode when a write is unreachable and refuses later writes without calling inner", async () => {
		const n = await world.seedIssue({ body: "cached" });
		const version = (await forge.getIssue(n)).version;
		await world.makeUnreachable();
		const spy = vi.spyOn(inner, "updateIssueBody");

		const error = await expectForgeError(
			forge.updateIssueBody(n, "new", version),
			"readonly",
		);

		expect(error.operation).toBe("updateIssueBody");
		expect(error.message).toContain("updateIssueBody");
		expect(error.message).toMatch(/could not be reached/);
		expect(forge.isReadOnly()).toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);

		await expectForgeError(
			forge.updateIssueBody(n, "again", version),
			"readonly",
		);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("passes HTTP errors from writes through without entering read-only mode", async () => {
		const n = await world.seedIssue({ body: "body" });
		await forge.getIssue(n);

		const error = await expectForgeError(
			forge.updateComment("missing-comment", "x", "cv:0" as Version),
			"http",
		);

		expect(error.status).toBe(404);
		expect(forge.isReadOnly()).toBe(false);
	});

	it("treats a corrupt cache file as not cached on the unreachable path", async () => {
		const n = await world.seedIssue({ body: "body" });
		await forge.getIssue(n);
		await writeFile(cachePath(n), "{not json", "utf8");
		await world.makeUnreachable();

		const error = await expectForgeError(forge.getIssue(n), "unreachable");

		expect(error).not.toBeInstanceOf(SyntaxError);
		expect(forge.isReadOnly()).toBe(true);
	});

	it("refetches over a corrupt cache file on the normal read path", async () => {
		const n = await world.seedIssue({ body: "fresh" });
		await forge.getIssue(n);
		await writeFile(cachePath(n), "{not json", "utf8");

		const issue = await forge.getIssue(n);

		expect(issue.body).toBe("fresh");
		expect((await readCacheFile(n)).issue).toEqual(
			expect.objectContaining({ body: "fresh" }),
		);
	});

	it("does not fail reads or writes when the cache directory cannot be written", async () => {
		const blocker = join(cacheRoot, "blocker");
		await writeFile(blocker, "not a directory", "utf8");
		const blocked = new CachedForge(inner, {
			cacheRoot: blocker,
			host: HOST,
			owner: OWNER,
			repo: REPO,
		});
		const n = await world.seedIssue({ body: "body" });

		const issue = await blocked.getIssue(n);
		expect(issue.body).toBe("body");

		const result = await blocked.updateIssueBody(n, "changed", issue.version);
		expect(result.status).toBe("written");
	});

	it("enters read-only mode when a non-issue read is unreachable", async () => {
		const n = await world.seedIssue({});
		await world.makeUnreachable();

		await expectForgeError(forge.listComments(n), "unreachable");
		expect(forge.isReadOnly()).toBe(true);
	});
});
