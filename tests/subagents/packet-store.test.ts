// Tests of the packet store: concurrent same-hash writes never leave a torn file, and a failed write leaves no temp file.
import { mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, test } from "vitest";
import { readPacket, writePacket } from "../../src/subagents/packet-store.ts";
import type { Packet } from "../../src/subagents/source-types.ts";
import { spillDirectory } from "../../src/subagents/spill.ts";
import { makeRepo } from "../helpers/repo.ts";

const HASH = "b".repeat(64);
const packet = (text: string): Packet => ({ text, hash: HASH, sources: [], skillPaths: [], cwd: "/w", seen: [] });

describe("packet store", () => {
	test("concurrent writes of one hash in one process all land and the packet stays readable", async () => {
		const root = await makeRepo();
		await Promise.all(Array.from({ length: 8 }, (_, i) => writePacket(root, "c", packet("x".repeat(20_000 + i)))));
		expect((await readPacket(root, "c", HASH))?.hash).toBe(HASH);
	});

	test("a failed write removes its temp file", async () => {
		const root = await makeRepo();
		const dir = dirname(await spillDirectory(root, "c", HASH));
		await mkdir(dir, { recursive: true });
		await mkdir(`${await spillDirectory(root, "c", HASH)}.packet.json`, { recursive: true });
		await expect(writePacket(root, "c", packet("p"))).rejects.toThrow();
		expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});
});
