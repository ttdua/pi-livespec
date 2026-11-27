// The only code path that runs `git push` and the only one that fetches `refs/livespec/*`
// (design D8). It is not a tool and not a bash command, so the guard never sees it. Only `change_ship`, `change_push`, `fix_ship`
// and `change_park` call `guardedPush`, after their refusal checks, with remote `origin`: the first two
// with refspec `HEAD:refs/heads/<Branch line>`, `fix_ship` with `HEAD:refs/heads/fix/<slug>`
// from the checked-out fix branch, `change_park` with `HEAD:refs/heads/<Branch line>--wip-<unit>`
// (command-guards "Guarded push"). `guardedDeleteWip` deletes a remote wip branch under a lease
// on its recorded head; its single caller is `change_resume` (command-guards "Guarded push", scenario "Delete of a wip branch").
// `ledgerFetch`, `ledgerPush` and `ledgerDelete` take only a change issue number and serve the git ledger on
// `refs/livespec/<n>`; only `src/ledger/sync.ts` references them.

import type { GitExec } from "../engine/git-exec.ts";
import { GitError } from "../engine/git.ts";

const REMOTE = "origin";

export type WipDeleteOutcome = "deleted" | "gone" | "moved";

/** Deletes `branch` on origin if it is still at `head`. Throws `GitError` on a refused name (no git call) or an unclassified failure. */
export async function guardedDeleteWip(exec: GitExec, root: string, branch: string, head: string): Promise<WipDeleteOutcome> {
	const ref = `refs/heads/${branch}`;
	if (!branch.includes("--wip-") || branch.startsWith("-")) {
		throw new GitError(["push", "--", REMOTE, `:${ref}`], null, "not a wip branch");
	}
	return leasedDelete(exec, root, ref, head);
}

/** Deletes `ref` on origin under a lease on `head`; re-reads the remote after a failure to tell "gone" and "moved" from a real error. */
async function leasedDelete(exec: GitExec, root: string, ref: string, head: string): Promise<WipDeleteOutcome> {
	const args = ["push", `--force-with-lease=${ref}:${head}`, "--", REMOTE, `:${ref}`];
	const before = await readRemote(exec, root, ref);
	if (before === null) return "gone";
	if (before !== head) return "moved";
	const result = await exec(args, { cwd: root });
	if (result.code === 0) return "deleted";
	const failure = new GitError(args, result.code, result.stderr || (result.spawnError ?? ""));
	let after: string | null;
	try {
		after = await readRemote(exec, root, ref);
	} catch {
		throw failure;
	}
	if (after === null) return "gone";
	if (after !== head) return "moved";
	throw failure;
}

/** The sha `ref` has on origin, or null when absent. Matches the exact ref name only (ls-remote also lists suffix matches). */
async function readRemote(exec: GitExec, root: string, ref: string): Promise<string | null> {
	const args = ["ls-remote", "--exit-code", "--", REMOTE, ref];
	const result = await exec(args, { cwd: root });
	if (result.code === 2) return null;
	if (result.code !== 0) throw new GitError(args, result.code, result.stderr || (result.spawnError ?? ""));
	for (const line of result.stdout.split("\n")) {
		const [sha, name] = line.split(/\s+/);
		if (name === ref && sha) return sha;
	}
	return null;
}

/** Pushes `refspec` to `remote` from `root`; `--` keeps either from being read as an option. Throws `GitError` on failure. */
export async function guardedPush(exec: GitExec, root: string, remote: string, refspec: string): Promise<void> {
	const args = ["push", "--", remote, refspec];
	const result = await exec(args, { cwd: root });
	if (result.code !== 0) throw new GitError(args, result.code, result.stderr || (result.spawnError ?? ""));
}

export type LedgerFetchOutcome = "fetched" | "absent";
export type LedgerPushOutcome = "pushed" | "rejected";
export type LedgerDeleteOutcome = WipDeleteOutcome;

const REJECTED = /rejected|fetch first|non-fast-forward/;

/** The ledger ref name for change issue `n`; throws `GitError` without running git unless `n` is a positive integer. */
function ledgerRef(n: number): string {
	if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) throw new GitError(["ledger"], null, "not a positive issue number");
	return `refs/livespec/${n}`;
}

/** Fetches `refs/livespec/<n>` from origin into `refs/livespec-origin/<n>`; "absent" when origin has none. Throws `GitError` on a bad number or failure. */
export async function ledgerFetch(exec: GitExec, root: string, n: number): Promise<LedgerFetchOutcome> {
	const ref = ledgerRef(n);
	if ((await readRemote(exec, root, ref)) === null) return "absent";
	const args = ["fetch", "--", REMOTE, `+${ref}:refs/livespec-origin/${n}`];
	const result = await exec(args, { cwd: root });
	if (result.code !== 0) throw new GitError(args, result.code, result.stderr || (result.spawnError ?? ""));
	return "fetched";
}

/** Pushes `tip` to `refs/livespec/<n>` on origin without force; "rejected" when origin has moved on. Throws `GitError` on a bad number or other failure. */
export async function ledgerPush(exec: GitExec, root: string, n: number, tip: string): Promise<LedgerPushOutcome> {
	const args = ["push", "--", REMOTE, `${tip}:${ledgerRef(n)}`];
	const result = await exec(args, { cwd: root });
	if (result.code === 0) return "pushed";
	if (REJECTED.test(result.stderr)) return "rejected";
	throw new GitError(args, result.code, result.stderr || (result.spawnError ?? ""));
}

/** Deletes `refs/livespec/<n>` on origin if it is still at `tip`. Throws `GitError` on a bad number or an unclassified failure. */
export async function ledgerDelete(exec: GitExec, root: string, n: number, tip: string): Promise<LedgerDeleteOutcome> {
	return leasedDelete(exec, root, ledgerRef(n), tip);
}
