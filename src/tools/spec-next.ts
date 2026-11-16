// `spec_next`: the next-step sentence and its supporting lists.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenChange } from "../engine/resolve-change.ts";
import type { NextStep } from "../engine/state-types.ts";
import { formatOpenChanges, formatStep } from "./format-step.ts";
import { requireSession, type ToolResult, toolResult } from "./guard.ts";
import { readCurrentChange } from "./read-change.ts";
import { registerLivespecTool } from "./register.ts";

export type SpecNextDetails = { step: NextStep | null; open?: OpenChange[] };

export async function runSpecNext(): Promise<ToolResult<SpecNextDetails>> {
	const s = requireSession();
	if (!s.ok) return toolResult(s.message, { step: null }, true);
	const current = await readCurrentChange(s.session);
	if (current.kind === "change") return toolResult(formatStep(current.step, current.state), { step: current.step });
	if (current.kind === "list") return toolResult(formatOpenChanges(current.open), { step: null, open: current.open });
	return toolResult(current.message, { step: null }, true);
}

export function registerSpecNext(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: "spec_next",
		label: "Next livespec step",
		description: "Rebuild the change snapshot and return the next step of the livespec flow, with its required skills, redirects, questions and units.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: { type: "object", properties: {} } as never,
		execute: () => runSpecNext(),
	});
}
