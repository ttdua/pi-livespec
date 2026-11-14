import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

// Registered at import time: every test file using makeRepo gets automatic cleanup.
afterEach(async () => {
	for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Create a temporary git repository (removed after each test) and return its root. */
export async function makeRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "livespec-"));
	created.push(root);
	execFileSync("git", ["init", "-q"], { cwd: root });
	return root;
}

/** Write a file under the repo root, creating parent folders. */
export async function writeIn(root: string, rel: string, text: string): Promise<void> {
	const full = join(root, rel);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, text);
}

/** Stage everything and commit with a fixed identity. */
export function commitAll(root: string, message = "init"): void {
	execFileSync("git", ["add", "-A"], { cwd: root });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message], { cwd: root });
}

/** `git status --porcelain` output lines. */
export function gitStatus(root: string): string[] {
	return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}
