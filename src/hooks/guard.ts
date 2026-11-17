// The `tool_call` guard (design D7): every `bash`, `write` and `edit` call of an
// initialized livespec project is checked before it runs. It fails closed: any
// internal error blocks the call. Registered before every other livespec
// `tool_call` handler, so a blocked call reaches none of them.

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../core/messages.ts";
import { classifyCommand, forgeEndpoints, type GuardContext, type GuardDecision } from "../guard/classify.ts";
import { isLivespecPath } from "../guard/paths.ts";
import { blockFor } from "../guard/rules.ts";
import type { Session } from "./session.ts";
import { getSession } from "./session-store.ts";

type ToolCallResult = { block: true; reason: string } | undefined;

const ALLOW: GuardDecision = { allow: true };
/** Aliases are read only for text that may run git; an alias body then decides like any command. */
const MENTIONS_GIT = /git/i;

/** `"unknown"` when the lookup fails: the classifier then treats unknown subcommands mentioning push as pushes. */
async function aliasesFor(session: Session, command: string): Promise<GuardContext["aliases"]> {
	if (!MENTIONS_GIT.test(command)) return {};
	try {
		return await session.git.aliases();
	} catch {
		return "unknown";
	}
}

async function checkBash(session: Session, input: Record<string, unknown>, cwd: string): Promise<GuardDecision> {
	const command = input.command;
	if (typeof command !== "string") throw new Error("bash input has no command text");
	const endpoints = forgeEndpoints(session.forgeTarget(), session.config.project);
	return classifyCommand(command, { cwd, endpoints, aliases: await aliasesFor(session, command) });
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The path as pi's `write` and `edit` tools read it (their path resolution is not exported): unicode
 * spaces become spaces, a leading `@` is dropped, `~` is the home directory and a `file://` URL is a path.
 */
function toolPath(raw: string): string {
	const path = raw.replace(UNICODE_SPACES, " ").replace(/^@/, "");
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path.startsWith("file://") ? fileURLToPath(path) : path;
}

function checkPath(input: Record<string, unknown>, cwd: string): GuardDecision {
	const path = input.path;
	if (typeof path !== "string") throw new Error("the call has no path");
	if (!isLivespecPath(cwd, toolPath(path))) return ALLOW;
	return blockFor("livespec-files", `${path} is under .pi/livespec/`, "the project flow and config are changed by a human only");
}

/** The decision for one call; tools other than bash, write and edit are not guarded. */
function decide(session: Session, toolName: string, input: Record<string, unknown>, cwd: string): Promise<GuardDecision> | GuardDecision {
	if (toolName === "bash") return checkBash(session, input, cwd);
	if (toolName === "write" || toolName === "edit") return checkPath(input, cwd);
	return ALLOW;
}

export function registerGuardHook(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx): Promise<ToolCallResult> => {
		try {
			const session = getSession();
			if (!session?.initialized) return undefined;
			const decision = await decide(session, event.toolName, event.input as Record<string, unknown>, ctx.cwd);
			return decision.allow ? undefined : { block: true, reason: decision.reason };
		} catch (error) {
			return { block: true, reason: `livespec guard failed: ${messageOf(error)}; the command was not run` };
		}
	});
}
