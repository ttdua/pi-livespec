// `docs_table`: replaces the rows of the change issue's `## Durable docs` table (design D6), in `review` or `ship`.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withEvidenceLock } from "../evidence/lock.ts";
import { shipContext } from "../ship/context.ts";
import { applyDocsTable, type DocsRow, docsRowsRefusal } from "../ship/docs-table.ts";
import { afterForgeWrite, prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { childRefusal, type ToolCtx } from "./subagent-target.ts";

const TOOL = "docs_table";
const PHASES = ["review", "ship"];
const RETRIES = 1;

export type DocsTableParams = { rows: DocsRow[] };

const refuse = (message: string): ToolResult<undefined> => toolResult(`${TOOL} refused: ${message} Nothing was written.`, undefined, true);

/** A versioned body write; one retry after re-reading when the issue changed. */
async function writeTable(w: WriteContext, n: number, rows: DocsRow[]): Promise<{ ok: true } | { ok: false; message: string }> {
	for (let attempt = 0; attempt <= RETRIES; attempt++) {
		const issue = await w.forge.getIssue(n);
		const result = await w.forge.updateIssueBody(n, applyDocsTable(issue.body, rows), issue.version);
		if (result.status === "written") return { ok: true };
	}
	return { ok: false, message: `the issue #${n} kept changing while the table was written; call ${TOOL} again.` };
}

async function setTable(p: DocsTableParams): Promise<ToolResult<undefined>> {
	const w = await prepareWrite();
	if (!w.ok) return refuse(w.message);
	const change = requireChange(w.session);
	if (!change.ok) return refuse(change.message);
	const { state } = change;
	const phase = state.phase.kind === "ok" ? state.phase.id : "";
	if (!PHASES.includes(phase)) return refuse(`the change is in ${phase || "no phase"}; the Durable docs table is written in ${PHASES.join(" or ")}.`);
	if (!Array.isArray(p.rows)) return refuse("rows must be a list.");
	const context = await shipContext(w.session, state);
	if ("refused" in context) return refuse(context.refused);
	const why = docsRowsRefusal(p.rows, context.facts);
	if (why !== undefined) return refuse(why);
	const written = await writeTable(w, state.issue.number, p.rows);
	if (!written.ok) return refuse(written.message);
	await afterForgeWrite(w.session, state.issue.number);
	return toolResult(`Wrote ${p.rows.length} Durable docs row(s) of #${state.issue.number}.`, undefined);
}

export function runDocsTable(p: DocsTableParams, ctx: ToolCtx): Promise<ToolResult<undefined>> {
	const child = childRefusal(TOOL, ctx);
	if (child) return Promise.resolve(child);
	return withEvidenceLock(() => setTable(p));
}

export function registerDocsTable(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Write the Durable docs table",
		description:
			"Replace the rows of the change issue's Durable docs table. Each row is a file and a status: `updated` (the file is in the change diff) or `not needed` with a reason. Allowed in review and ship; refuses a not-needed row a hard requirement covers.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: {
			type: "object",
			properties: {
				rows: {
					type: "array",
					items: {
						type: "object",
						properties: { file: { type: "string" }, status: { type: "string", enum: ["updated", "not needed"] }, reason: { type: "string" } },
						required: ["file", "status"],
					},
				},
			},
			required: ["rows"],
		} as never,
		execute: (_id, params, _signal, _update, ctx) => runDocsTable(params as DocsTableParams, ctx as ToolCtx),
	});
}
