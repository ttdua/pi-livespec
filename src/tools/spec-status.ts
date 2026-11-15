// `spec_status`: the current change state as text and structured details.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenChange } from "../engine/resolve-change.ts";
import type { ChangeState } from "../engine/state-types.ts";
import { formatOpenChanges, formatState } from "./format-step.ts";
import { requireSession, type ToolResult, toolResult } from "./guard.ts";
import { readCurrentChange } from "./read-change.ts";
import { registerLivespecTool } from "./register.ts";

export type SpecStatusDetails = { state: ChangeState | null; open?: OpenChange[] };

export async function runSpecStatus(): Promise<ToolResult<SpecStatusDetails>> {
	const s = requireSession();
	if (!s.ok) return toolResult(s.message, { state: null }, true);
	const current = await readCurrentChange(s.session);
	if (current.kind === "change") return toolResult(formatState(current.step, current.state), { state: current.state });
	if (current.kind === "list") return toolResult(formatOpenChanges(current.open), { state: null, open: current.open });
	return toolResult(current.message, { state: null }, true);
}

export function registerSpecStatus(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: "spec_status",
		label: "livespec status",
		description: "Rebuild the change snapshot and return the change state: phase, units, questions, counters, check results and the stale flag.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: {} } as never,
		execute: () => runSpecStatus(),
	});
}
