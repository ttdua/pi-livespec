// `change_resume #N` (design D14, spec discovered-dependencies "Resume tool").

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import type { ToolCtx } from "./subagent-target.ts";

export type ChangeResumeParams = { issue: number };
export type ChangeResumeDetails = { merged?: string[] };

const TOOL = "change_resume";

export async function runChangeResume(_params: ChangeResumeParams, _ctx: ToolCtx, _signal?: AbortSignal): Promise<ToolResult<ChangeResumeDetails>> {
	throw new Error("not implemented");
}

export function registerChangeResume(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Resume a parked livespec change",
		description: "Resume a parked change once every change it waits for is merged.",
		parameters: { type: "object", properties: { issue: { type: "number" } }, required: ["issue"] } as never,
		execute: (_id, params, signal, _update, ctx) => runChangeResume(params as ChangeResumeParams, ctx as ToolCtx, signal),
	});
}
