// The real-process `AccountEnv`: the default `gh` runner, `git`, the process
// environment, global `fetch` and tea's own config lookup.

import { defaultGitExec } from "../engine/git-exec.ts";
import { defaultExec } from "../forge/github.ts";
import type { AccountEnv } from "./types.ts";

export function defaultAccountEnv(): AccountEnv {
	return {
		exec: defaultExec,
		git: defaultGitExec,
		env: process.env,
		fetch: globalThis.fetch,
		teaLookup: { env: process.env },
		now: Date.now,
	};
}
