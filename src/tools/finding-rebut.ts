// `finding_rebut`: the parent rebuts a blocking finding of a review summary with a reason and evidence.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withEvidenceLock } from "../evidence/lock.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { isChildSession, type ChildCheckContext } from "../subagents/child.ts";
import { isBlocking, rebuttalComment, type RebuttalData } from "../subagents/records.ts";
import type { Finding } from "../subagents/roles.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { appendRecord } from "./subagent-request.ts";

const TOOL = "finding_rebut";

export type RebutParams = { comment: string; index: number; reason: string; evidence: string };

const refuse = (message: string): ToolResult<undefined> => toolResult(`${TOOL} refused: ${message} Nothing was written.`, undefined, true);
const blank = (text: unknown): boolean => typeof text !== "string" || text.trim() === "";

/** The finding `index` of the review summary comment `commentId`, or why there is none. */
function findingOf(marked: MarkedComment[], commentId: string, index: number): Finding | string {
	const summary = marked.find((m) => m.ref === commentId && m.kind === "finding-summary");
	const data = summary?.data as { findings?: Finding[]; advisory?: boolean } | undefined;
	const findings = data?.findings;
	if (data?.advisory === true) return `${commentId} is an advisory review: its findings never block, so there is nothing to rebut.`;
	if (!Array.isArray(findings)) return `${commentId} is not a review summary comment of this change.`;
	return findings[index] ?? `finding ${index} does not exist in ${commentId} (it has ${findings.length}).`;
}

/** Why `finding` cannot be rebutted, or undefined. */
function unrebuttable(finding: Finding): string | undefined {
	if (finding.kind === "missed-context") return "a missed-context finding cannot be rebutted: give the child the missing context and review again.";
	return isBlocking(finding) ? undefined : "that finding is not blocking, so there is nothing to rebut.";
}

/** The latest rebuttal items already posted for `commentId`: a new rebuttal replaces the comment, so it must carry them. */
function earlierItems(marked: MarkedComment[], commentId: string): RebuttalData["items"] {
	const prior = marked.filter((m) => m.kind === "finding-summary" && (m.data as Partial<RebuttalData>).rebuts === commentId).at(-1);
	return (prior?.data as RebuttalData | undefined)?.items ?? [];
}

export async function runFindingRebut(p: RebutParams, ctx?: ChildCheckContext): Promise<ToolResult<undefined>> {
	if (ctx !== undefined && isChildSession(ctx)) return refuse("only the main session rebuts findings; this is a child session.");
	if (blank(p.reason)) return refuse("a reason is required.");
	if (blank(p.evidence)) return refuse("evidence is required.");
	// A rebuttal rewrites the summary's item list read from the state: two parallel calls must not drop an item.
	return withEvidenceLock(() => postRebuttal(p));
}

async function postRebuttal(p: RebutParams): Promise<ToolResult<undefined>> {
	const w = await prepareWrite();
	if (!w.ok) return refuse(w.message);
	const change = requireChange(w.session);
	if (!change.ok) return refuse(change.message);
	const { state } = change;
	const finding = findingOf(state.marked, p.comment, p.index);
	if (typeof finding === "string") return refuse(finding);
	const why = unrebuttable(finding);
	if (why !== undefined) return refuse(why);
	const items = [...earlierItems(state.marked, p.comment).filter((i) => i.index !== p.index), { index: p.index, reason: p.reason, evidence: p.evidence }];
	await appendRecord(w, state.issue.number, rebuttalComment({ rebuts: p.comment, items }));
	return toolResult(`Rebutted finding ${p.index} of ${p.comment}; it no longer blocks unit_finish, and the next human gate lists the rebuttal.`, undefined);
}

export function registerFindingRebut(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: TOOL,
		label: "Rebut a livespec review finding",
		description:
			"Rebut one blocking finding of a review summary comment with a reason and evidence. A missed-context finding cannot be rebutted. The rebuttal is listed in the next human gate.",
		// Plain JSON-schema literal; cast avoids a typebox dependency.
		parameters: {
			type: "object",
			properties: { comment: { type: "string" }, index: { type: "number" }, reason: { type: "string" }, evidence: { type: "string" } },
			required: ["comment", "index", "reason", "evidence"],
		} as never,
		execute: (_id, params, _signal, _update, ctx) => runFindingRebut(params as RebutParams, ctx as never),
	});
}
