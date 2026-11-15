// Shared shapes of per-clone account resolution: candidates, their write
// access, the stored choice, the selection facts and result, and the single
// I/O seam (`AccountEnv`) every account module reads through.

import type { GitExec } from "../engine/git-exec.ts";
import type { ExecFn } from "../forge/github.ts";
import type { TeaLookup } from "../forge/tea-config.ts";

/** One account that may act on the forge: a `gh` login or a `tea` login name, and the forge user it authenticates as. */
export interface AccountCandidate {
	name: string;
	user: string;
}

/** Whether a candidate can push to the repository; `unknown` is never write access. */
export type Access = "true" | "false" | "unknown";

/** The account stored in the clone's local git config, with the remote it was chosen for (`<host>/<owner>/<repo>`). */
export interface StoredAccount {
	account: string;
	remote: string;
}

export type AccountSource = "env" | "stored" | "auto" | "asked";

/** Human label of each source, as doctor, card and command show it. */
export const SOURCE_LABEL: Readonly<Record<AccountSource, string>> = {
	env: "environment",
	stored: "stored",
	auto: "automatic",
	asked: "asked",
};

/** Everything the pure selection decides on. */
export interface SelectionFacts {
	forge: "github" | "gitea";
	/** The environment token of the forge in use is set. */
	envToken: boolean;
	stored?: StoredAccount;
	/** Current `<host>/<owner>/<repo>` of `origin`. */
	remote: string;
	candidates: { candidate: AccountCandidate; access: Access }[];
	hasUI: boolean;
}

export type SelectionResult =
	| { kind: "env" }
	| { kind: "use"; account: string; source: "stored"; unverified: boolean }
	| { kind: "store"; account: string; source: "auto" }
	| { kind: "ask"; options: string[] }
	| { kind: "refuse"; reason: "ambiguous" | "no-access" | "no-candidates" | "invalid"; options: string[] };

/** The single injection seam for every account I/O: `gh`, `git`, the HTTP access check and the `tea` config path. */
export interface AccountEnv {
	exec: ExecFn;
	git: GitExec;
	env: Record<string, string | undefined>;
	fetch: typeof fetch;
	teaLookup: Omit<TeaLookup, "baseUrl" | "login">;
	now: () => number;
}
