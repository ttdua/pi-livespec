import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type CommandEnv } from "./commands/deps.ts";
import { messageOf } from "./commands/messages.ts";
import {
	type Reply,
	doctorReply,
	initReply,
	migrateReply,
	nextReply,
	skillsReply,
	validateReply,
} from "./commands/subcommands.ts";
import { registerContextHooks } from "./hooks/context.ts";
import { type SessionDeps, defaultSessionDeps, registerSessionHooks } from "./hooks/session.ts";
import { registerChangeTools } from "./tools/change-tools.ts";
import { registerSpecValidate } from "./tools/spec-validate.ts";
import { readVersion } from "./version.ts";

const USAGE = "Usage: /livespec [validate | migrate-openspec | init | doctor | next | skills <status|update|pin <sha>|unpin|rollback>]";

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

/** `deps` replaces the real home, forge detection or content manager, for tests. */
export default function extension(pi: ExtensionAPI, deps: Partial<SessionDeps> = {}): void {
	const env: SessionDeps = { ...defaultSessionDeps(), ...deps };
	pi.registerCommand("livespec", {
		description: "Show the pi-livespec version; subcommands: validate, migrate-openspec, init, doctor, next, skills",
		handler: async (args, ctx) => {
			const { sub, rest } = splitArgs(args);
			const out = await reply(sub, rest, ctx, env);
			pi.sendMessage({ customType: out.customType, content: out.content, display: true });
			if (out.error !== undefined) ctx.ui.notify(out.error, "error");
		},
	});
	registerSpecValidate(pi);
	registerChangeTools(pi);
	registerSessionHooks(pi, env);
	registerContextHooks(pi);
}
