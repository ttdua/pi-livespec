// What a `Verify` run needs from the session: the root, git, the project config,
// the guard, the redaction tokens, the timeout and one abort signal combining the
// tool call's signal with the session's shutdown signal.

import { DEFAULT_VERIFY_TIMEOUT_S, type ProjectConfig } from "../config.ts";
import type { Git } from "../engine/git.ts";
import { classifyCommand, forgeEndpoints, type GuardContext } from "../guard/classify.ts";
import type { Session } from "../hooks/session.ts";
import type { RunOptions } from "./runner.ts";

/** The tail kept for `unit-start` and `receipt` output, truncation mark included. */
export const RECEIPT_OUTPUT_BYTES = 8192;

export type VerifyEnv = { root: string; git: Git; config: ProjectConfig | null; run: Omit<RunOptions, "cwd" | "tailBytes"> };

/** Unknown aliases make the guard treat any alias as possibly dangerous. */
async function readAliases(git: Git): Promise<GuardContext["aliases"]> {
	try {
		return await git.aliases();
	} catch {
		return "unknown";
	}
}

/** Where a run happens when it is not the change worktree: a lane worktree and the git over it. */
export type RunWorktree = { root: string; git: Git };

/** Builds the run environment once per tool call; aliases are read once here. `at` moves it into a lane worktree. */
export async function verifyEnv(session: Session, signal?: AbortSignal, at?: RunWorktree): Promise<VerifyEnv> {
	const config = session.config.project;
	const git = at?.git ?? session.git;
	const root = at?.root ?? session.cwd;
	const ctx: GuardContext = { cwd: root, endpoints: forgeEndpoints(session.forgeTarget(), config), aliases: await readAliases(git) };
	const guard = (cmd: string): string | undefined => {
		const decision = classifyCommand(cmd, ctx);
		return decision.allow ? undefined : decision.reason;
	};
	const signals = signal === undefined ? [session.shutdownSignal] : [signal, session.shutdownSignal];
	return {
		root,
		git,
		config,
		run: { timeoutS: config?.verify?.timeoutS ?? DEFAULT_VERIFY_TIMEOUT_S, guard, tokens: session.redactionTokens(), signal: AbortSignal.any(signals) },
	};
}
