// `fix_start <slug>`: fetches the integration branch and creates and switches to `fix/<slug>` at its
// head. A fix has no issue, so it writes nothing to the forge and never pushes.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { messageOf } from "../core/messages.ts";
import { isKebabName } from "../core/names.ts";
import { integrationBranch } from "../engine/git.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { requireSession, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

const TOOL = "fix_start";
const REMOTE = "origin";
const FIX_PREFIX = "fix/";
const CHANGE_PREFIX = "livespec/";

export type FixStartParams = { slug: string };
export type FixStartDetails = undefined;

const refuse = (message: string): ToolResult<FixStartDetails> => toolResult(`${TOOL} refused: ${message} Nothing was created.`, undefined, true);

export async function runFixStart(p: FixStartParams, ctx: ToolCtx): Promise<ToolResult<FixStartDetails>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return child;
	const s = requireSession();
	if (!s.ok) return refuse(s.message);
	const { git, config } = s.session;
	const current = await git.branch();
	if (current.startsWith(CHANGE_PREFIX)) return refuse(`the current branch ${untrusted(current)} is a change branch; switch off it first.`);
	if (typeof p.slug !== "string" || !isKebabName(p.slug)) return refuse("the slug is not kebab-case (lowercase words joined by single hyphens).");
	const branch = `${FIX_PREFIX}${p.slug}`;
	if (await git.isDirty()) return refuse("the working tree has uncommitted changes; commit or stash them, then rerun.");
	if (await git.branchExists(branch)) return refuse(`the local branch ${branch} already exists.`);
	const integration = config.project ? await integrationBranch(config.project, git) : undefined;
	if (integration === undefined) return refuse("the integration branch is unknown: origin/HEAD is not set. Set integrationBranch in .pi/livespec/config.yaml.");
	try {
		await git.fetch(REMOTE, integration);
		const sha = await git.revParse(`${REMOTE}/${integration}`);
		await git.switchCreate(branch, sha);
		return toolResult(`Started ${branch} at ${REMOTE}/${integration} ${sha}. No issue was created and nothing was pushed.`, undefined);
	} catch (error) {
		return refuse(`git failed: ${untrusted(messageOf(error))}.`);
	}
}

export function registerFixStart(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Start a fix",
		description:
			"Start a small fix without an issue: fetch the integration branch from origin, then create and switch to fix/<slug> at its head. Creates no issue and never pushes. Refuses on a dirty tree, on a livespec/* branch, or when fix/<slug> exists.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: {
			type: "object",
			properties: { slug: { type: "string", description: "kebab-case slug of the fix; the branch is fix/<slug>" } },
			required: ["slug"],
		} as never,
		execute: (_id, params, _signal, _update, ctx) => runFixStart(params as FixStartParams, ctx as ToolCtx),
	});
}
