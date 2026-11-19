// The last packet of a dispatched unit, kept beside the spill files so a finish after a reload can still check freshness.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spillDirectory } from "./spill.ts";
import type { Packet } from "./source-types.ts";

const SAFE_HASH = /^[0-9a-f]{8,64}$/;

/** `<spill dir of the hash>.packet.json`; undefined for a hash that is not hex, so a record cannot name a path. */
async function packetFile(root: string, change: string, hash: string): Promise<string | undefined> {
	if (!SAFE_HASH.test(hash)) return undefined;
	return `${await spillDirectory(root, change, hash)}.packet.json`;
}

/** Stores `packet` under its hash. Throws when git cannot say where the common dir is. */
export async function writePacket(root: string, change: string, packet: Packet): Promise<void> {
	const file = await packetFile(root, change, packet.hash);
	if (file === undefined) throw new Error(`packet hash ${packet.hash} is not a hex digest`);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(packet));
}

/** The stored packet of `hash`, or undefined when it was never stored or is unreadable. */
export async function readPacket(root: string, change: string, hash: string): Promise<Packet | undefined> {
	try {
		const file = await packetFile(root, change, hash);
		if (file === undefined) return undefined;
		const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Packet>;
		return parsed.hash === hash && Array.isArray(parsed.sources) && Array.isArray(parsed.seen) ? (parsed as Packet) : undefined;
	} catch {
		return undefined;
	}
}
