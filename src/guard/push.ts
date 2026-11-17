// The only code path that runs `git push` (design D8). It is not a tool and not
// a bash command, so the guard never sees it. No tool imports it in LS-06; LS-09
// adds the callers, which check the change state first.

import type { GitExec } from "../engine/git-exec.ts";
import { GitError } from "../engine/git.ts";

/** Pushes `refspec` to `remote` from `root`; `--` keeps either from being read as an option. Throws `GitError` on failure. */
export async function guardedPush(exec: GitExec, root: string, remote: string, refspec: string): Promise<void> {
	const args = ["push", "--", remote, refspec];
	const result = await exec(args, { cwd: root });
	if (result.code !== 0) throw new GitError(args, result.code, result.stderr || (result.spawnError ?? ""));
}
