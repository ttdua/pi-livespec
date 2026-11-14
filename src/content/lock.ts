// `livespec.lock`: the record of the active agent-skills commit, pin, install
// history, skipped commits and last check time.

import { readFile, rename, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";

export type Lock = {
	source: string;
	commit: string;
	pinned: string | null;
	history: string[];
	skipped: string[];
	checkedAt: string | null;
};

export class LockError extends Error {
	constructor(path: string, detail: string) {
		super(`${path}: ${detail}`);
		this.name = "LockError";
	}
}

/** `undefined` when the file does not exist; a malformed file throws `LockError`. */
export async function readLock(path: string): Promise<Lock | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return toLock(path, parseYaml(path, text));
}

/** Writes to a sibling temp file, then renames it over `path`. */
export async function writeLock(path: string, lock: Lock): Promise<void> {
	const tmp = `${path}.tmp`;
	await writeFile(tmp, stringify(lock), "utf8");
	await rename(tmp, path);
}

function parseYaml(path: string, text: string): unknown {
	try {
		return parse(text);
	} catch (error) {
		throw new LockError(path, `invalid YAML (${(error as Error).message.split("\n")[0]})`);
	}
}

const isString = (v: unknown): v is string => typeof v === "string";
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function toLock(path: string, value: unknown): Lock {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LockError(path, "expected a mapping");
	const v = value as Record<string, unknown>;
	if (!isString(v.source) || !isString(v.commit)) throw new LockError(path, "`source` and `commit` must be strings");
	if (v.pinned !== null && !isString(v.pinned)) throw new LockError(path, "`pinned` must be a string or null");
	if (!isStringList(v.history) || !isStringList(v.skipped)) throw new LockError(path, "`history` and `skipped` must be string lists");
	if (v.checkedAt !== null && !isString(v.checkedAt)) throw new LockError(path, "`checkedAt` must be a string or null");
	return { source: v.source, commit: v.commit, pinned: v.pinned, history: v.history, skipped: v.skipped, checkedAt: v.checkedAt };
}

/** Trees kept for rollback, the active one included. */
export const KEPT_TREES = 5;

export function freshLock(source: string): Lock {
	return { source, commit: "", pinned: null, history: [], skipped: [], checkedAt: null };
}

/** `sha` becomes active and the newest history entry; an explicit install un-skips it. */
export function withInstalled(lock: Lock, sha: string): Lock {
	const history = [...lock.history.filter((s) => s !== sha), sha].slice(-KEPT_TREES);
	return { ...lock, commit: sha, history, skipped: lock.skipped.filter((s) => s !== sha) };
}

/** The previous history entry becomes active and the abandoned commit is skipped. */
export function withRolledBack(lock: Lock, previous: string): Lock {
	const abandoned = lock.commit;
	const skipped = lock.skipped.includes(abandoned) ? lock.skipped : [...lock.skipped, abandoned];
	return { ...lock, commit: previous, history: lock.history.filter((s) => s !== abandoned), skipped };
}
