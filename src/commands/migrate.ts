import { execFile } from "node:child_process";
import { lstat, mkdir, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const defaultExec = promisify(execFile);

type Exec = (file: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string | Buffer }>;

export type MigrateOptions = { exec?: Exec };
export type MigrateResult = { moved: string[]; conflicts: string[] };

/** Raised when `git mv` fails midway; already moved files stay moved. */
export class MigrateError extends Error {
	constructor(
		readonly moved: string[],
		readonly failed: string,
		readonly hint: string,
		cause: unknown,
	) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`git mv failed for ${failed}: ${reason}`);
		this.name = "MigrateError";
	}
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function withPath(error: unknown, path: string): Error {
	const base = error instanceof Error ? error : new Error(String(error));
	return Object.assign(new Error(`${path}: ${base.message}`), { code: (base as NodeJS.ErrnoException).code });
}

/** lstat that treats only ENOENT as absent; never follows symlinks. */
async function lstatOrNull(path: string): Promise<Stats | null> {
	try {
		return await lstat(path);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw withPath(error, path);
	}
}

/** Capability names that have a regular (non-symlink) file `openspec/specs/<cap>/spec.md`, sorted. */
async function collectCapabilities(root: string): Promise<string[]> {
	const base = join(root, "openspec", "specs");
	let entries;
	try {
		entries = await readdir(base, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw withPath(error, base);
	}
	const caps: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const st = await lstatOrNull(join(base, entry.name, "spec.md"));
		if (st?.isFile()) caps.push(entry.name);
	}
	return caps.sort();
}

async function checkParent(root: string, rel: string): Promise<string | null> {
	const st = await lstatOrNull(join(root, rel));
	if (st === null || (st.isDirectory() && !st.isSymbolicLink())) return null;
	return `${rel} (not a real directory)`;
}

async function untrackedSources(root: string, paths: string[], exec: Exec): Promise<Set<string>> {
	const { stdout } = await exec("git", ["ls-files", "-z", "--", ...paths], { cwd: root });
	const tracked = new Set(String(stdout).split("\0").filter(Boolean));
	return new Set(paths.filter((p) => !tracked.has(p)));
}

/** Every predictable reason the migration cannot run, computed before anything is touched. */
async function findConflicts(root: string, caps: string[], exec: Exec): Promise<string[]> {
	const conflicts: string[] = [];
	const specsConflict = await checkParent(root, "specs");
	if (specsConflict) conflicts.push(specsConflict);
	const seen = new Set<string>();
	for (const cap of caps) {
		const target = `specs/${cap}/spec.md`;
		const key = target.toLowerCase();
		if (seen.has(key)) conflicts.push(`${target} (duplicate target)`);
		seen.add(key);
		if (specsConflict) continue;
		const capConflict = await checkParent(root, `specs/${cap}`);
		if (capConflict) conflicts.push(capConflict);
		else if (await lstatOrNull(join(root, target))) conflicts.push(target);
	}
	const sources = caps.map((c) => `openspec/specs/${c}/spec.md`);
	if (sources.length > 0) {
		for (const path of await untrackedSources(root, sources, exec)) conflicts.push(`${path} (not tracked by git)`);
	}
	return conflicts;
}

/**
 * Move only `openspec/specs/<cap>/spec.md` to `specs/<cap>/spec.md` with `git mv`.
 * The whole plan is checked first; if anything conflicts nothing is touched.
 */
export async function runMigrate(root: string, { exec = defaultExec as Exec }: MigrateOptions = {}): Promise<MigrateResult> {
	const caps = await collectCapabilities(root);
	const conflicts = await findConflicts(root, caps, exec);
	if (conflicts.length > 0) return { moved: [], conflicts };
	const moved: string[] = [];
	for (const cap of caps) {
		const target = `specs/${cap}/spec.md`;
		try {
			await mkdir(join(root, "specs", cap), { recursive: true });
			await exec("git", ["mv", "--", `openspec/specs/${cap}/spec.md`, target], { cwd: root });
		} catch (error) {
			throw new MigrateError(moved, target, recoveryHint(moved, cap), error);
		}
		moved.push(target);
	}
	return { moved, conflicts: [] };
}

function recoveryHint(moved: string[], failedCap: string): string {
	if (moved.length === 0) {
		return `Nothing was moved; fix the cause and re-run. Check openspec/specs/${failedCap}/spec.md and specs/${failedCap}.`;
	}
	const sources = moved.map((m) => `openspec/${m}`).join(" ");
	return `Moved files stay moved. To undo: git restore --staged --worktree -- ${sources} && git rm -f -- ${moved.join(" ")}. Or fix the cause and re-run for the rest. This tool performs no reset.`;
}

export function formatMigrate({ moved, conflicts }: MigrateResult): string {
	if (conflicts.length > 0) {
		return `migrate-openspec refused; nothing was moved. Conflicts:\n${conflicts.map((c) => `- ${c}`).join("\n")}`;
	}
	if (moved.length === 0) return "migrate-openspec: nothing to migrate (no openspec/specs/<cap>/spec.md files).";
	return `migrate-openspec moved ${moved.length} spec file(s) with git mv:\n${moved.map((m) => `- ${m}`).join("\n")}`;
}

export function formatMigrateError(error: MigrateError): string {
	const moved = error.moved.length > 0 ? error.moved.map((m) => `- ${m}`).join("\n") : "- (none)";
	return `migrate-openspec failed midway.\nMoved before failure:\n${moved}\nFailed: ${error.failed}\nReason: ${error.message}\nRecovery: ${error.hint}`;
}
