import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Create a temporary git repository and return its root. */
export async function makeRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "livespec-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	return root;
}

/** Write a file under the repo root, creating parent folders. */
export async function writeIn(root: string, rel: string, text: string): Promise<void> {
	const full = join(root, rel);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, text);
}
