// `lane_open { unit }`: opens a parallel lane worktree for one ready unit and posts its `lane` record.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withEvidenceLock } from "../evidence/lock.ts";
import { openLane } from "../subagents/lane-ops.ts";
import { laneChange, laneRefusal } from "../subagents/lanes.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";
import { UNIT_PARAMETERS } from "./unit-tool.ts";

const TOOL = "lane_open";

const refuse = (message: string): ToolResult<undefined> => toolResult(`${TOOL} refused: ${message} Nothing was created or posted.`, undefined, true);

export function runLaneOpen(unit: string, ctx: ToolCtx): Promise<ToolResult<undefined>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return Promise.resolve(child);
	return withEvidenceLock(async () => {
		const w = await prepareWrite();
		if (!w.ok) return refuse(w.message);
		const change = requireChange(w.session);
		if (!change.ok) return refuse(change.message);
		const { state } = change;
		const why = laneRefusal(state, unit, w.session.config.user.lanes);
		if (why !== undefined) return refuse(why);
		const issue = state.issue.number;
		const ops = { git: w.session.git, root: w.session.cwd, post: (body: string) => w.forge.createComment(issue, body).then(() => undefined) };
		const opened = await openLane(ops, laneChange(state), unit);
		if (!opened.ok) return refuse(opened.message);
		await afterForgeWrite(w.session, issue);
		return toolResult(withStep(w.session, `Opened the lane of ${unit} at ${opened.path}; run unit_start ${unit}, and its implementer runs there.`), undefined);
	});
}

export function registerLaneOpen(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Open a livespec lane",
		description:
			"Open a parallel lane for one ready unit: a git worktree at .worktrees/<change>--<unit> on livespec/<change>--lane-<unit> from the change branch HEAD, recorded on the change issue. Refuses without a capable executor, over the user's lane limit, or when the unit's Files overlap an open lane. Takes only the unit id.",
		parameters: UNIT_PARAMETERS as never,
		execute: (_id, params, _signal, _update, ctx) => runLaneOpen((params as { unit: string }).unit, ctx as ToolCtx),
	});
}
