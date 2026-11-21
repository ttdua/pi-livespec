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
import { appendBareWork, isBareWork, localDate } from "../guard/bare-work.ts";
import { isLivespecPath } from "../guard/paths.ts";
import { blockFor, GUARD_PREFIX } from "../guard/rules.ts";
import { isChildSession } from "../subagents/child.ts";
import type { Session } from "./session.ts";
import { getSession } from "./session-store.ts";

type ToolCallResult = { block: true; reason: string } | undefined;

const ALLOW: GuardDecision = { allow: true };
/**
 * Read on every bash call: the shell may spell `git` in a form no text prefilter sees (`g''it`, `\\git`),
 * so only the classifier, after unquoting, knows whether git runs. `"unknown"` when the lookup fails: the
 * classifier then treats unknown subcommands mentioning push as pushes.
 */
async function aliasesOf(session: Session): Promise<GuardContext["aliases"]> {
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
	return classifyCommand(command, { cwd, endpoints, aliases: await aliasesOf(session) });
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

/** Warnings of allowed bare-work edits, by tool call id, until the call's `tool_result` appends them. */
const warnings = new Map<string, string>();

type BareWorkCall = { toolName: "write" | "edit"; toolCallId: string; path: string; cwd: string };

/** Advisory (design D7): logs a bare-work edit and keeps a warning for the result; any failure becomes a not-logged warning, never a block. */
async function recordBareWork(session: Session, call: BareWorkCall): Promise<void> {
	let rel = call.path;
	try {
		const found = await isBareWork({ root: call.cwd, path: toolPath(call.path), branch: await session.git.branch(), tracked: (p) => session.git.isTracked(p) });
		if (found === undefined) return;
		rel = found;
		const logged = await appendBareWork(call.cwd, found, call.toolName, localDate(new Date()));
		if (logged.error !== undefined) throw new Error(logged.error);
		warnings.set(call.toolCallId, `${GUARD_PREFIX} ${found} is a tracked file outside specs/ edited while neither a change nor a fix branch is checked out; it was logged as bare work in specs/bare-work.md. Start a fix with fix_start or a change with change_start.`);
	} catch (error) {
		warnings.set(call.toolCallId, `${GUARD_PREFIX} ${rel} was edited outside a change or fix branch, but the work was not logged in specs/bare-work.md (${messageOf(error)}).`);
	}
}

async function checkPath(session: Session, input: Record<string, unknown>, cwd: string, toolName: "write" | "edit", toolCallId: string, isChild: boolean): Promise<GuardDecision> {
	const path = input.path;
	if (typeof path !== "string") throw new Error("the call has no path");
	if (isLivespecPath(cwd, toolPath(path))) return blockFor("livespec-files", `${path} is under .pi/livespec/`, "the project flow and config are changed by a human only");
	if (!isChild) await recordBareWork(session, { toolName, toolCallId, path, cwd });
	return ALLOW;
}

/** The decision for one call; tools other than bash, write and edit are not guarded. */
function decide(session: Session, event: { toolName: string; toolCallId: string }, input: Record<string, unknown>, cwd: string, isChild: boolean): Promise<GuardDecision> | GuardDecision {
	const { toolName, toolCallId } = event;
	if (toolName === "bash") return checkBash(session, input, cwd);
	if (toolName === "write" || toolName === "edit") return checkPath(session, input, cwd, toolName, toolCallId, isChild);
	return ALLOW;
}

export function registerGuardHook(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx): Promise<ToolCallResult> => {
		try {
			const session = getSession();
			if (!session?.initialized) return undefined;
			const decision = await decide(session, event, event.input as Record<string, unknown>, ctx.cwd, isChildSession(ctx));
			return decision.allow ? undefined : { block: true, reason: decision.reason };
		} catch (error) {
			return { block: true, reason: `livespec guard failed: ${messageOf(error)}; the command was not run` };
		}
	});
	pi.on("tool_result", (event) => {
		const warning = warnings.get(event.toolCallId);
		if (warning === undefined) return undefined;
		warnings.delete(event.toolCallId);
		return { content: [...event.content, { type: "text" as const, text: warning }] };
	});
	pi.on("tool_execution_end", (event) => {
		warnings.delete(event.toolCallId);
	});
}
