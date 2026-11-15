// Every livespec tool registers through `registerLivespecTool`, so approval
// polling (design D3) runs before the tool's own work. Polling never throws.

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSession } from "../hooks/session-store.ts";
import { pollApprovals } from "../interaction/poll.ts";

/** Polls the current session's approval requests first; without an initialized session there is nothing to poll. */
async function pollFirst(): Promise<void> {
	const session = getSession();
	if (session?.initialized) await pollApprovals(session);
}

export function registerLivespecTool(pi: ExtensionAPI, def: ToolDefinition): void {
	pi.registerTool({
		...def,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			await pollFirst();
			return def.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
