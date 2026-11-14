// Which skills were added, removed or changed between two trees, by the
// sha-256 of each skill's `SKILL.md`.

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type SkillChanges = { added: string[]; removed: string[]; changed: string[] };

export async function diffSkills(oldTree: string | undefined, newTree: string, names: string[]): Promise<SkillChanges> {
	const changes: SkillChanges = { added: [], removed: [], changed: [] };
	for (const name of [...names].sort()) {
		const before = oldTree === undefined ? undefined : await skillHash(oldTree, name);
		const after = await skillHash(newTree, name);
		if (before === after) continue;
		if (before === undefined) changes.added.push(name);
		else if (after === undefined) changes.removed.push(name);
		else changes.changed.push(name);
	}
	return changes;
}

/** Directory names under `<tree>/skills/` of every given tree, sorted and unique. */
export async function skillDirNames(...trees: string[]): Promise<string[]> {
	const names = new Set<string>();
	for (const tree of trees) for (const name of await listDir(join(tree, "skills"))) names.add(name);
	return [...names].sort();
}

async function skillHash(tree: string, name: string): Promise<string | undefined> {
	try {
		return createHash("sha256").update(await readFile(join(tree, "skills", name, "SKILL.md"))).digest("hex");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function listDir(path: string): Promise<string[]> {
	try {
		return await readdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
