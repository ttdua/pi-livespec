// Bare mirror of the agent-skills upstream, driven only through `git`.
// Checkouts use a temporary index so the mirror's own index is never written.

import { access, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { GitExec } from "../engine/git-exec.ts";
import { GitError } from "../engine/git.ts";
import type { ContentPaths } from "./paths.ts";

export type Mirror = {
	/** Clones the mirror from `source` when it does not exist yet. */
	ensure(source: string): Promise<void>;
	/** Fetches with prune and returns the upstream head sha. */
	fetch(): Promise<string>;
	/** Writes the tree of the full 40-hex `sha` into `dir`. */
	checkout(sha: string, dir: string): Promise<void>;
	/** The full sha of commit `ref`; throws `GitError` when unknown. */
	resolve(ref: string): Promise<string>;
};

/** Caller-supplied refs follow it, so they are never parsed as options. */
const END_OF_OPTIONS = "--end-of-options";
const FULL_SHA = /^[0-9a-f]{40}$/;
const INDEX_SUFFIX = ".index";

export function createMirror(paths: ContentPaths, exec: GitExec): Mirror {
	const gitDir = ["--git-dir", paths.mirror];
	const run = async (args: string[], env?: Record<string, string>): Promise<string> => {
		const r = await exec(args, env ? { env } : undefined);
		if (r.code !== 0) throw new GitError(args, r.code, r.spawnError ?? r.stderr);
		return r.stdout.trim();
	};

	return {
		ensure: async (source) => {
			if (await exists(paths.mirror)) return;
			await mkdir(dirname(paths.mirror), { recursive: true });
			try {
				await run(["clone", "--quiet", "--mirror", "--", source, paths.mirror]);
			} catch (error) {
				await rm(paths.mirror, { recursive: true, force: true });
				throw error;
			}
		},
		fetch: async () => {
			await run([...gitDir, "fetch", "--quiet", "--prune"]);
			return run([...gitDir, "rev-parse", "--verify", "HEAD^{commit}"]);
		},
		checkout: async (sha, dir) => {
			if (!FULL_SHA.test(sha)) throw new Error(`checkout needs a full 40-hex sha, got \`${sha}\``);
			await mkdir(dir, { recursive: true });
			const index = `${dir}${INDEX_SUFFIX}`;
			try {
				await run([...gitDir, "--work-tree", dir, "checkout", "--quiet", "-f", END_OF_OPTIONS, sha, "--", "."], { GIT_INDEX_FILE: index });
			} finally {
				await rm(index, { force: true });
			}
		},
		resolve: (ref) => run([...gitDir, "rev-parse", "--verify", "--quiet", END_OF_OPTIONS, `${ref}^{commit}`]),
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
