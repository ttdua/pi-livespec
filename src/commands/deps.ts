// Dependencies of the `/livespec` subcommands, taken from the running livespec
// session when it belongs to the command's project, otherwise read fresh.

import { lstat, readdir } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type LoadedConfig, loadConfig } from "../config.ts";
import type { ContentManager } from "../content/manager.ts";
import { workInProgress } from "../content/wip.ts";
import { defaultGitExec } from "../engine/git-exec.ts";
import { loadPack } from "../engine/pack-load.ts";
import { createLedger, type Ledger } from "../ledger/index.ts";
import type { LoadedPack } from "../engine/pack-types.ts";
import type { Forge } from "../forge/types.ts";
import type { Session, SessionDeps } from "../hooks/session.ts";
import { getSession } from "../hooks/session-store.ts";
import type { DoctorDeps } from "./doctor.ts";
import type { InitDeps } from "./init.ts";
import { messageOf } from "./messages.ts";
import type { SkillsCommandDeps } from "./skills.ts";

/** What the commands share with the session hooks: home, forge detection and the content manager. */
export type CommandEnv = Pick<SessionDeps, "home" | "detect" | "content">;
export type ForgeConnection = { forge: Forge; readOnly: boolean };

const NO_FORGE_WIP = "no forge is connected, so work in progress is unknown";

/** The current session when it was started in `cwd`; a session of another project is not used. */
export function sessionFor(cwd: string): Session | undefined {
	const session = getSession();
	return session?.cwd === cwd ? session : undefined;
}

function packFor(cwd: string): Promise<LoadedPack> {
	const session = sessionFor(cwd);
	return session?.initialized ? Promise.resolve(session.pack) : loadPack(cwd);
}

function configFor(cwd: string, env: CommandEnv): Promise<LoadedConfig> {
	const session = sessionFor(cwd);
	return session ? Promise.resolve(session.config) : loadConfig(cwd, env.home);
}

/** The session's ledgers when it runs in `cwd`, else ledgers of the repository at `cwd`. */
function ledgerFor(cwd: string): Ledger {
	return sessionFor(cwd)?.ledger ?? createLedger(defaultGitExec, cwd);
}

/** The session's cached forge with its read-only mode, or a freshly detected one. Throws when detection fails. */
export async function forgeFor(cwd: string, env: CommandEnv): Promise<ForgeConnection> {
	const cached = sessionFor(cwd)?.forge;
	if (cached) return { forge: cached, readOnly: cached.isReadOnly() };
	return { forge: await env.detect(cwd), readOnly: false };
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function listDir(path: string): Promise<string[]> {
	try {
		return (await readdir(path)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export function contentFor(env: CommandEnv): ContentManager {
	return env.content(env.home);
}

export function initDeps(cwd: string, env: CommandEnv): InitDeps {
	return { content: contentFor(env), pack: () => loadPack(cwd) };
}

export async function doctorDeps(ctx: ExtensionCommandContext, env: CommandEnv): Promise<DoctorDeps> {
	const config = await configFor(ctx.cwd, env);
	const skills = ctx.getSystemPromptOptions().skills ?? [];
	const session = sessionFor(ctx.cwd);
	return {
		root: ctx.cwd,
		home: env.home,
		initialized: config.project !== null,
		pack: await packFor(ctx.cwd),
		loadedSkills: skills.map((s) => ({ name: s.name, filePath: s.filePath })),
		isTrusted: ctx.isProjectTrusted(),
		content: contentFor(env),
		forge: () => forgeFor(ctx.cwd, env),
		exists,
		listDir,
		config,
		hasUI: ctx.hasUI,
		...(session?.account ? { account: session.account } : {}),
		...(session?.accountBlock !== undefined ? { accountBlock: session.accountBlock } : {}),
	};
}

export async function skillsDeps(cwd: string, env: CommandEnv): Promise<SkillsCommandDeps> {
	const config = await configFor(cwd, env);
	return {
		content: contentFor(env),
		pack: await packFor(cwd),
		channel: config.user.agentSkills.channel,
		wip: async () => {
			const connection = await forgeFor(cwd, env).catch((error: unknown) => {
				throw new Error(`${NO_FORGE_WIP}: ${messageOf(error)}`);
			});
			return workInProgress(connection.forge, ledgerFor(cwd));
		},
	};
}
