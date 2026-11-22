// `change_sync` (design D12): the parent-only tool over `syncChange`, run under the evidence lock because it
// runs `Verify` and writes unit ticks.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withEvidenceLock } from "../evidence/lock.ts";
import { syncChange } from "../initiatives/sync.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { withStep } from "./request-flow.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

export type ChangeSyncDetails = { base?: string; stale?: string[] };

const TOOL = "change_sync";

const refuse = (message: string): ToolResult<ChangeSyncDetails> => toolResult(`${TOOL} refused: ${message}`, {}, true);

function syncedText(n: number, base: string, stale: string[]): string {
	if (stale.length === 0) return `Synced #${n} with Base ${base}: every done unit's Verify is green.`;
	return `Synced #${n} with Base ${base}: ${stale.join(", ")} regressed or cover a changed requirement, so they are unticked and stale.`;
}

export async function runChangeSync(ctx: ToolCtx, signal?: AbortSignal): Promise<ToolResult<ChangeSyncDetails>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return { ...child, details: {} };
	return withEvidenceLock(async () => {
		const w = await prepareWrite();
		if (!w.ok) return refuse(w.message);
		const change = requireChange(w.session);
		if (!change.ok) return refuse(change.message);
		const n = change.state.issue.number;
		const result = await syncChange({ session: w.session, forge: w.forge, state: change.state, ...(signal ? { signal } : {}) });
		await afterForgeWrite(w.session, n);
		if ("refused" in result) return refuse(result.refused);
		return toolResult(withStep(w.session, syncedText(n, result.base, result.stale)), { base: result.base, stale: result.stale });
	});
}

export function registerChangeSync(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Sync a livespec change",
		description:
			"Merge origin/<integration branch> into the change branch, record its tip as Base, re-run every done unit's Verify into one regression record, and untick the done units that went red or cover a requirement changed between the bases. Refuses on a dirty tree, a started unit, off the change branch, or on a merge conflict (aborted). Never pushes.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No parameters.
		parameters: { type: "object", properties: {} } as never,
		execute: (_id, _params, signal, _update, ctx) => runChangeSync(ctx as ToolCtx, signal),
	});
}
