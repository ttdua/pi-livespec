// The completion context of a session (design D2): one builder shared by the
// tools that complete an in-session answer and by the poll that completes
// forge answers, so both record the same repository root and agent-skills commit.

import { basename } from "node:path";
import type { Pack } from "../engine/pack-types.ts";
import type { MarkedComment } from "../forge/markers.ts";
import type { Forge } from "../forge/types.ts";
import type { Session } from "../hooks/session.ts";
import type { CompletionCtx } from "./complete-effects.ts";

/** The agent-skills commit: the basename of the active content tree, when one is active. */
export function agentSkillsOf(session: Pick<Session, "activeTree">): string | undefined {
	return session.activeTree === undefined ? undefined : basename(session.activeTree);
}

/** The completion context for `issue` from the session's git, cwd and active content tree. */
export function sessionCompletionCtx(session: Pick<Session, "git" | "cwd" | "activeTree">, forge: Forge, pack: Pack, issue: number, marked: MarkedComment[]): CompletionCtx {
	const ctx: CompletionCtx = { forge, git: session.git, pack, issue, marked, root: session.cwd, now: () => new Date() };
	const skills = agentSkillsOf(session);
	if (skills !== undefined) ctx.agentSkills = skills;
	return ctx;
}
