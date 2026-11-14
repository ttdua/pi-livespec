import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type MigrateResult = { moved: string[]; conflicts: string[] };

async function isFile(path: string): Promise<boolean> {
	return stat(path).then((s) => s.isFile(), () => false);
}

/** Capability names that have a regular file `openspec/specs/<cap>/spec.md`, sorted. */
async function collectCapabilities(root: string): Promise<string[]> {
	const base = join(root, "openspec", "specs");
	const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
	const caps: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory() && (await isFile(join(base, entry.name, "spec.md")))) caps.push(entry.name);
	}
	return caps.sort();
}

/**
 * Move only `openspec/specs/<cap>/spec.md` to `specs/<cap>/spec.md` with `git mv`.
 * If any target exists, nothing is touched and the conflicting targets are returned.
 */
export async function runMigrate(root: string): Promise<MigrateResult> {
	const caps = await collectCapabilities(root);
	const conflicts = caps.map((c) => `specs/${c}/spec.md`).filter((t) => existsSync(join(root, t)));
	if (conflicts.length > 0) return { moved: [], conflicts };
	const moved: string[] = [];
	for (const cap of caps) {
		const target = `specs/${cap}/spec.md`;
		await mkdir(join(root, "specs", cap), { recursive: true });
		await run("git", ["mv", "--", `openspec/specs/${cap}/spec.md`, target], { cwd: root });
		moved.push(target);
	}
	return { moved, conflicts: [] };
}

export function formatMigrate({ moved, conflicts }: MigrateResult): string {
	if (conflicts.length > 0) {
		return `migrate-openspec refused; nothing was moved. Targets already exist:\n${conflicts.map((c) => `- ${c}`).join("\n")}`;
	}
	if (moved.length === 0) return "migrate-openspec: nothing to migrate (no openspec/specs/<cap>/spec.md files).";
	return `migrate-openspec moved ${moved.length} spec file(s) with git mv:\n${moved.map((m) => `- ${m}`).join("\n")}`;
}
