// Spill files: where oversized sources go (under the git common dir, never in a commit) and how they are written.

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { defaultGitExec } from "../engine/git-exec.ts";
import { untrusted } from "../hooks/phase-card.ts";
import type { PacketSource } from "./source-types.ts";

export const SPILL_PLACEHOLDER = "<spill>";

const SAFE = /[^A-Za-z0-9._-]/g;
const MAX_NAME = 80;

/** `<spill>/<n>-<id>.md`: the placeholder form every hash is computed with. */
export function spillName(index: number, id: string): string {
	return `${index + 1}-${id.replace(SAFE, "_").slice(0, MAX_NAME)}.md`;
}

/** The file's content: title, then the text, wrapped when it came from outside livespec. */
export function spillContent(source: PacketSource): string {
	return `# ${source.title}\n\nsource: ${source.id}\nversion: ${source.version}\n\n${source.untrusted ? untrusted(source.text) : source.text}\n`;
}

/** `<git common dir>/livespec/packets/<change>/<hash>`, shared by every lane worktree. Throws when git cannot say. */
export async function spillDirectory(root: string, change: string, hash: string): Promise<string> {
	const result = await defaultGitExec(["rev-parse", "--git-common-dir"], { cwd: root });
	if (result.code !== 0) throw new Error(`cannot find the git common dir: ${result.stderr.trim() || result.spawnError || "git failed"}`);
	const common = result.stdout.trim();
	return join(isAbsolute(common) ? common : resolve(root, common), "livespec", "packets", change.replace(SAFE, "_"), hash);
}

export async function writeSpills(dir: string, files: { name: string; source: PacketSource }[]): Promise<void> {
	if (files.length === 0) return;
	await mkdir(dir, { recursive: true });
	for (const f of files) await writeFile(join(dir, f.name), spillContent(f.source));
}
