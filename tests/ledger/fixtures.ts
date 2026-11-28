import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { setTestIdentity } from "../helpers/repo.ts";

const created: string[] = [];

afterEach(async () => {
	for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

export type TwoClones = { remote: string; a: string; b: string };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A bare `origin` and two clones of it with committer identities; all removed after each test. */
export async function twoClones(): Promise<TwoClones> {
	const base = await mkdtemp(join(tmpdir(), "livespec-ledger-sync-"));
	created.push(base);
	const remote = join(base, "remote.git");
	git(base, ["init", "-q", "--bare", remote]);
	const [a, b] = [join(base, "a"), join(base, "b")];
	for (const clone of [a, b]) {
		git(base, ["clone", "-q", remote, clone]);
		setTestIdentity(clone);
	}
	return { remote, a, b };
}

/** Points `origin` of `clone` at a missing path; the returned function points it back. */
export function offline(clone: string): () => void {
	const url = git(clone, ["remote", "get-url", "origin"]);
	git(clone, ["config", "remote.origin.url", join(tmpdir(), "livespec-missing-origin", String(process.pid))]);
	return () => git(clone, ["config", "remote.origin.url", url]);
}
