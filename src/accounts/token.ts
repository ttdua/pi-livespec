// The token of one candidate: `gh auth token --hostname --user` for GitHub,
// the named `tea` login of the target's host for Gitea. The token is returned
// to the caller only; it is never logged or put on argv. Environment tokens
// (`GH_TOKEN`, `GITEA_TOKEN`) are not consulted: a candidate acts as itself.

import type { ForgeTarget } from "../forge/detect.ts";
import { targetTeaLogins } from "./candidates.ts";
import type { AccountEnv } from "./types.ts";

export type TokenDeps = Pick<AccountEnv, "exec" | "teaLookup">;

/** The candidate's own token, or `undefined` when it has none for this target. `signal` aborts the `gh` lookup. */
export async function candidateToken(d: TokenDeps, target: ForgeTarget, name: string, signal?: AbortSignal): Promise<string | undefined> {
	return target.kind === "github" ? githubToken(d, target.authority, name, signal) : giteaToken(d, target, name);
}

async function githubToken(d: TokenDeps, host: string, login: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	const result = await d.exec("gh", ["auth", "token", "--hostname", host, "--user", login], undefined, undefined, signal);
	if (result.spawnError !== undefined || result.code !== 0) return undefined;
	const token = result.stdout.trim();
	return token === "" ? undefined : token;
}

async function giteaToken(d: TokenDeps, target: ForgeTarget, name: string): Promise<string | undefined> {
	return (await targetTeaLogins(d, target)).find((l) => l.name === name)?.token;
}
