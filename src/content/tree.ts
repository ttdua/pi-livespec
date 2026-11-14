// Immutable `<sha>/` trees and the `current` link: staging plus compatibility
// check, atomic switch, and pruning of trees no longer kept.

import { readdir, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { basename } from "node:path";
import type { Pack } from "../engine/pack-types.ts";
import { type CompatFailure, checkCompat } from "./compat.ts";
import type { Mirror } from "./mirror.ts";
import type { ContentPaths } from "./paths.ts";

export type TreeResult = { ok: true; tree: string } | { ok: false; failures: CompatFailure[] };

const SHA_DIR = /^[0-9a-f]{40}$/;
const CURRENT_TMP_SUFFIX = ".tmp";

/**
 * Makes `<sha>/` hold a compatible tree. A kept tree is re-checked in place, because the pack may have changed;
 * a new one is checked out into staging, checked, and only then renamed. A failed staging dir is deleted.
 */
export async function installTree(paths: ContentPaths, mirror: Mirror, sha: string, pack: Pack): Promise<TreeResult> {
	const tree = paths.tree(sha);
	if (await isDirectory(tree)) {
		const kept = await checkCompat(tree, pack);
		return kept.ok ? { ok: true, tree } : { ok: false, failures: kept.failures };
	}
	const staging = paths.staging(sha);
	try {
		await mirror.checkout(sha, staging);
		const compat = await checkCompat(staging, pack);
		if (!compat.ok) {
			await rm(staging, { recursive: true, force: true });
			return { ok: false, failures: compat.failures };
		}
		await rename(staging, tree);
		return { ok: true, tree };
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

/** Points `current` at `<sha>/` atomically: a relative link `current.tmp` renamed over `current`. */
export async function switchCurrent(paths: ContentPaths, sha: string): Promise<void> {
	const tmp = `${paths.current}${CURRENT_TMP_SUFFIX}`;
	await rm(tmp, { force: true });
	await symlink(sha, tmp);
	await rename(tmp, paths.current);
}

/** The real `<sha>/` path behind `current`; `undefined` when no clone is active. */
export async function readActiveTree(paths: ContentPaths): Promise<string | undefined> {
	try {
		return await realpath(paths.current);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export const shaOfTree = (tree: string): string => basename(tree);

export const hasTree = (paths: ContentPaths, sha: string): Promise<boolean> => isDirectory(paths.tree(sha));

/** Deletes every `<sha>/` tree not listed in `keep`. */
export async function pruneTrees(paths: ContentPaths, keep: string[]): Promise<void> {
	const kept = new Set(keep);
	for (const name of await readdir(paths.root)) {
		if (SHA_DIR.test(name) && !kept.has(name)) await rm(paths.tree(name), { recursive: true, force: true });
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
