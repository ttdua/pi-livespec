// Per-turn hooks: the routing note section, the phase card appended at the end
// of the messages, the skill-read observer and the skill exposure. Every
// handler catches and degrades; none throws into pi or blocks a tool.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exposedSkillPaths } from "../content/expose.ts";
import { messageOf } from "../commands/messages.ts";
import { renderCard } from "./phase-card.ts";
import { ROUTING_NOTE } from "./routing-note.ts";
import type { Session } from "./session.ts";
import { getSession } from "./session-store.ts";
import { skillOfRead } from "./skill-reads.ts";

export const ROUTING_SECTION = "livespec";
export const PHASE_CARD_TYPE = "livespec-phase-card";
/** A constant timestamp keeps the card byte-identical across turns. */
const CARD_TIMESTAMP = 0;
const READ_TOOL = "read";
const NO_SKILLS = { skillPaths: [] as string[] };

export type PhaseCardMessage = { role: "user"; customType: typeof PHASE_CARD_TYPE; content: string; timestamp: typeof CARD_TIMESTAMP };

function initializedSession(): Session | undefined {
	const session = getSession();
	return session?.initialized ? session : undefined;
}

function warn(ctx: ExtensionContext, hook: string, error: unknown): void {
	try {
		ctx.ui.notify(`livespec ${hook} hook failed: ${messageOf(error)}`, "warning");
	} catch {
		// The UI is gone; nothing else can report the failure.
	}
}

export function phaseCardMessage(session: Session): PhaseCardMessage {
	return { role: "user", customType: PHASE_CARD_TYPE, content: renderCard(session.card), timestamp: CARD_TIMESTAMP };
}

/** The optional skill of the active phase named by a `read` of `<activeTree>/skills/<name>/SKILL.md`. */
function optionalSkillRead(session: Session, input: unknown, cwd: string): string | undefined {
	const path = (input as { path?: unknown } | undefined)?.path;
	if (typeof path !== "string" || session.activeTree === undefined || !session.pack.ok) return undefined;
	const skill = skillOfRead(path, cwd, session.activeTree);
	if (skill === undefined) return undefined;
	const optional = new Set(session.pack.pack.phases.flatMap((p) => p.skills.optional));
	return optional.has(skill) ? skill : undefined;
}

export function registerContextHooks(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const session = initializedSession();
		if (!session) return;
		try {
			event.systemPromptOptions.sections[ROUTING_SECTION] = ROUTING_NOTE;
			await session.refresh();
		} catch (error) {
			warn(ctx, "before_agent_start", error);
		}
	});

	pi.on("context", async (event, ctx) => {
		const session = initializedSession();
		if (!session) return undefined;
		try {
			// Pi's message union has no member for an untyped custom user message; the shape is the Contracts one.
			return { messages: [...event.messages, phaseCardMessage(session) as unknown as (typeof event.messages)[number]] };
		} catch (error) {
			warn(ctx, "context", error);
			return undefined;
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const session = initializedSession();
		if (!session || event.toolName !== READ_TOOL) return undefined;
		try {
			const skill = optionalSkillRead(session, event.input, ctx.cwd);
			if (skill !== undefined) session.skillReads.record(skill);
		} catch (error) {
			warn(ctx, "tool_call", error);
		}
		return undefined;
	});

	pi.on("resources_discover", async (_event, ctx) => {
		try {
			const session = getSession();
			if (!session) return NO_SKILLS;
			const activeTree = session.activeTree;
			return { skillPaths: exposedSkillPaths({ initialized: session.initialized, pack: session.pack, ...(activeTree === undefined ? {} : { activeTree }) }) };
		} catch (error) {
			getSession()?.record("resources_discover", error);
			warn(ctx, "resources_discover", error);
			return NO_SKILLS;
		}
	});
}
