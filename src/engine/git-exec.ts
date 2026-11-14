// Git runner with per-call env. Separate from the forge `ExecFn` because the
// content mirror needs `GIT_INDEX_FILE` per call without touching process.env.

import { execFile } from "node:child_process";
import type { ExecResult } from "../forge/github.ts";

export type GitExec = (args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>;

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Runs `git`; resolves on any exit, and reports a failure to start as `code: null` with `spawnError`. */
export const defaultGitExec: GitExec = (args, opts = {}) =>
	new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: MAX_BUFFER_BYTES },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") {
					resolve({ stdout, stderr, code: null, spawnError: error.message });
					return;
				}
				resolve({ stdout, stderr, code: error ? (error.code as number) : 0 });
			},
		);
	});
