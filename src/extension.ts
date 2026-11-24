import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
// Registered for side effect: the forge-account doctor check and card section, the approvals card section and the approver doctor check.
import "./accounts/card.ts";
import "./accounts/doctor.ts";
import "./interaction/card.ts";
import "./interaction/doctor.ts";
// The `parked` and `regression` marker kinds.
import "./deps/markers.ts";
// The readiness refresh facts and the initiative card section.
import "./initiatives/facts.ts";
import "./initiatives/card.ts";
// The parked card section, after the initiative section.
import "./deps/card.ts";
// The evidence card section.
import "./evidence/card.ts";
// The subagents card section.
import "./subagents/card.ts";
import "./subagents/doctor.ts";
// Registers the `subagents` pack sub-schema.
import "./subagents/policy.ts";
import { registerDocReaders } from "./docs/readers.ts";
import { type CommandEnv } from "./commands/deps.ts";
import { messageOf } from "./core/messages.ts";
import {
	type Reply,
	accountReply,
	doctorReply,
	initReply,
	migrateReply,
	nextReply,
	skillsReply,
	validateReply,
} from "./commands/subcommands.ts";
import { setRedOnBaseEnv } from "./evidence/red-on-base.ts";
import { verifyEnv } from "./evidence/verify-env.ts";
import { registerStartedUnitWorkInProgress } from "./evidence/wip.ts";
import { registerContextHooks } from "./hooks/context.ts";
import { registerGuardHook } from "./hooks/guard.ts";
import { getSession } from "./hooks/session-store.ts";
import { type SessionDeps, defaultSessionDeps, registerSessionHooks } from "./hooks/session.ts";
import { registerSettleHooks } from "./hooks/settle.ts";
import { registerChangeTools } from "./tools/change-tools.ts";
import { registerSpecValidate } from "./tools/spec-validate.ts";
import { readVersion } from "./version.ts";

const USAGE = "Usage: /livespec [validate | migrate-openspec | init | doctor | next | account [name] | skills <status|update|pin <sha>|unpin|rollback>]";

function route(sub: string, rest: string, ctx: ExtensionCommandContext, env: CommandEnv): Promise<Reply> | Reply {
	switch (sub) {
		case "":
			return { customType: "livespec-version", content: `pi-livespec ${readVersion()}` };
		case "validate":
			return validateReply(ctx);
		case "migrate-openspec":
			return migrateReply(ctx);
		case "init":
			return initReply(ctx, env);
		case "doctor":
			return doctorReply(ctx, env);
		case "next":
			return nextReply(ctx);
		case "account":
			return accountReply(rest, ctx);
		case "skills":
			return skillsReply(rest, ctx, env);
		default:
			return { customType: "livespec-usage", content: USAGE };
	}
}

/** A subcommand that throws still answers, with the reason, instead of failing inside pi. */
async function reply(sub: string, rest: string, ctx: ExtensionCommandContext, env: CommandEnv): Promise<Reply> {
	try {
		return await route(sub, rest, ctx, env);
	} catch (error) {
		return { customType: "livespec-error", content: `/livespec ${sub} failed: ${messageOf(error)}`, error: `livespec ${sub} failed` };
	}
}

function splitArgs(args: string): { sub: string; rest: string } {
	const trimmed = args.trim();
	const sub = trimmed.split(/\s+/)[0] ?? "";
	return { sub, rest: trimmed.slice(sub.length).trim() };
}

/** Best effort: the UI may be gone (pi shutting down); a notice then has nowhere to go. */
function safeNotify(ctx: ExtensionCommandContext, message: string): void {
	try {
		ctx.ui.notify(message, "error");
	} catch {
		// Nothing else can report it.
	}
}

/** Shows the reply; a failed send falls back to a notice. Never throws. */
function deliver(pi: ExtensionAPI, ctx: ExtensionCommandContext, out: Reply): void {
	try {
		pi.sendMessage({ customType: out.customType, content: out.content, display: true });
	} catch (error) {
		safeNotify(ctx, `livespec could not show its reply: ${messageOf(error)}`);
	}
	if (out.error !== undefined) safeNotify(ctx, out.error);
}

/** Parse, route and deliver inside one boundary, so the command never rejects into pi. */
async function handleCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, env: CommandEnv): Promise<void> {
	try {
		const { sub, rest } = splitArgs(args);
		deliver(pi, ctx, await reply(sub, rest, ctx, env));
	} catch (error) {
		safeNotify(ctx, `livespec failed: ${messageOf(error)}`);
	}
}

/** `deps` replaces the real home, forge detection or content manager, for tests. */
export default function extension(pi: ExtensionAPI, deps: Partial<SessionDeps> = {}): void {
	const env: SessionDeps = { ...defaultSessionDeps(), ...deps };
	// First: a blocked call must reach no other livespec `tool_call` handler.
	registerGuardHook(pi);
	registerDocReaders();
	pi.registerCommand("livespec", {
		description: "Show the pi-livespec version; subcommands: validate, migrate-openspec, init, doctor, next, account, skills",
		handler: (args, ctx) => handleCommand(pi, args, ctx, env),
	});
	registerSpecValidate(pi);
	registerChangeTools(pi);
	registerSessionHooks(pi, env);
	registerContextHooks(pi);
	registerSettleHooks(pi);
	registerStartedUnitWorkInProgress();
	setRedOnBaseEnv(async () => {
		const session = getSession();
		return session?.initialized ? verifyEnv(session) : undefined;
	});
}
