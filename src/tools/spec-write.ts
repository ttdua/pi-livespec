// `spec_write`: writes one of the Capabilities / Product impact header lines or
// the Proposal / Design sections of the change issue, with the version it read.
// A conflict writes nothing and is reported; nothing is retried.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";
import { applyWrite, planWrite, postconditionFailure, SPEC_WRITE_SECTIONS } from "./spec-write-rules.ts";

export type SpecWriteParams = { section: string; content: string };

export type SpecWriteDetails = { number?: number; changed?: string[] };

export async function runSpecWrite(p: SpecWriteParams): Promise<ToolResult<SpecWriteDetails>> {
	const plan = planWrite(p.section, p.content);
	if (!plan.ok) return toolResult(plan.message, {}, true);
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, {}, true);
	const change = requireChange(w.session);
	if (!change.ok) return toolResult(change.message, {}, true);
	const n = change.state.issue.number;
	const issue = await w.forge.getIssue(n);
	const body = applyWrite(issue.body, plan.write);
	const broken = postconditionFailure(issue.body, body, plan.write);
	if (broken) return toolResult(`spec_write refused: ${broken}; nothing was written.`, { number: n }, true);
	const result = await w.forge.updateIssueBody(n, body, issue.version);
	if (result.status === "conflict") {
		const changed = result.changed.join(", ") || "unknown fields";
		return toolResult(
			`Version conflict on #${n}: the issue changed since it was read (${changed}). Nothing was written; call spec_write again to write over the new version.`,
			{ number: n, changed: result.changed },
			true,
		);
	}
	await afterForgeWrite(w.session, n);
	return toolResult(`Wrote ${p.section} of #${n}.`, { number: n });
}

export function registerSpecWrite(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "spec_write",
		label: "Write change section",
		description:
			"Write the Capabilities or Product impact line, or the Proposal or Design section, of the current change issue. Capabilities reads `new [a, b], modified [c]` with kebab-case names; Proposal and Design are non-empty and contain no `## ` heading. Units belongs to plan_units.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: {
			type: "object",
			properties: {
				section: { type: "string", enum: [...SPEC_WRITE_SECTIONS] },
				content: { type: "string" },
			},
			required: ["section", "content"],
		} as never,
		execute: (_id, params) => runSpecWrite(params as SpecWriteParams),
	});
}
