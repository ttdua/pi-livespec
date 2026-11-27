// `spec_stuck` (design D12): writes a `stuck` report comment with id `S<n>` (the
// next free number), then sends a blocking `stuck:S<n>` request whose options
// are the report's options. While a report is unanswered a second one is
// refused; a report left without a request (the chain refused) is sent again.
// Completion writes `S<n>-answer` (`complete-stuck.ts`).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeState } from "../engine/state-types.ts";
import { type MarkedComment, writeMarked } from "../forge/markers.ts";
import { type ApprovalRequest, isSubject, type RequestOption, type StuckSnapshot, type Subject } from "../interaction/approver.ts";
import { neutralise, validateBriefing, validateOptionTexts } from "../interaction/briefing.ts";
import { openRequestFor, prepareRequest } from "../interaction/requests.ts";
import type { ApproverCtx } from "./approver-for.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult, type WriteContext } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { sendRequest } from "./request-flow.ts";

export type StuckTried = { text: string; link?: string };
export type SpecStuckParams = { where: string; tried: StuckTried[]; hypothesis: string; options: RequestOption[]; recommended: string; rationale: string };

/** The `stuck` report comment data (plan Contracts, Marker `stuck` data). */
export type StuckReport = { where: string; tried: StuckTried[]; hypothesis: string; options: RequestOption[]; recommended: string; rationale?: string };

/** Strict validates everything (tool params); lenient only skips description, rationale and length rules (stored reports). */
export type StuckMode = { strict: boolean };

const TOOL = "spec_stuck";
const STUCK_KIND = "stuck";
const SUBJECT_PREFIX = "stuck:";

/** The subject of stuck report `id`; a report id is always `S<n>`, so anything else is a bug. */
function stuckSubject(id: string): Subject {
	const subject = `${SUBJECT_PREFIX}${id}`;
	if (!isSubject(subject)) throw new Error(`not a stuck id: ${id}`);
	return subject;
}
const REPORT_ID = /^S(\d+)(?:-answer)?$/;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 3;

const refusal = (message: string): { refused: string } => ({ refused: `${TOOL} refused: ${message} Nothing was written.` });

// --- pure planning -------------------------------------------------------------------

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function triedOf(raw: unknown): StuckTried[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: StuckTried[] = [];
	for (const t of raw) {
		const entry = (typeof t === "object" && t !== null ? t : {}) as { text?: unknown; link?: unknown };
		if (!isText(entry.text)) return undefined;
		const text = neutralise(entry.text);
		out.push(isText(entry.link) ? { text, link: neutralise(entry.link) } : { text });
	}
	return out;
}

function optionsOf(raw: unknown): RequestOption[] | { refused: string } {
	if (!Array.isArray(raw) || raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) return refusal(`a stuck report needs two or three options.`);
	const options: RequestOption[] = [];
	for (const o of raw) {
		const entry = (typeof o === "object" && o !== null ? o : {}) as { id?: unknown; label?: unknown; description?: unknown };
		if (!isText(entry.id) || /\s/.test(entry.id) || !isText(entry.label)) return refusal("every option needs an id without spaces and a label.");
		if (options.some((x) => x.id === entry.id)) return refusal(`option id ${entry.id} is given twice.`);
		options.push(isText(entry.description) ? { id: entry.id, label: entry.label, description: entry.description } : { id: entry.id, label: entry.label });
	}
	return options;
}

/** The field names of the stuck tool, not the briefing's, in a refusal. */
const fieldNames = (message: string): string => message.replace("briefing.summary", "hypothesis").replace(/briefing\./g, "");

/** Strict text rules: hypothesis and rationale go through the briefing validation; returns neutralised copies. */
function strictTexts(p: SpecStuckParams, options: RequestOption[]): { hypothesis: string; rationale: string; options: RequestOption[] } | { refused: string } {
	const described = validateOptionTexts(options, { requireDescription: true });
	if ("refused" in described) return refusal(`${described.refused}.`);
	const briefing = validateBriefing({ summary: p.hypothesis, recommended: p.recommended, rationale: p.rationale }, options.map((o) => o.id), { author: "agent" });
	if ("refused" in briefing) return refusal(`${fieldNames(briefing.refused)}.`);
	return { hypothesis: briefing.summary, rationale: briefing.rationale ?? "", options: described };
}

/** Lenient text rules: a stored report keeps what it has; its texts are only neutralised. */
function lenientTexts(p: SpecStuckParams, options: RequestOption[]): { hypothesis: string; rationale?: string; options: RequestOption[] } | { refused: string } {
	const checked = options.map((o) => ({ ...o, label: neutralise(o.label), ...(o.description === undefined ? {} : { description: neutralise(o.description) }) }));
	const rationale = isText(p.rationale) ? neutralise(p.rationale) : undefined;
	return { hypothesis: neutralise(p.hypothesis), ...(rationale === undefined ? {} : { rationale }), options: checked };
}

/** Validates the report; where, tried, hypothesis, two or three options and a recommended option among them are always required. */
export function stuckReport(p: SpecStuckParams, mode: StuckMode): StuckReport | { refused: string } {
	const options = optionsOf(p.options);
	if ("refused" in options) return options;
	if (!isText(p.where)) return refusal("where the work stopped is required.");
	const tried = triedOf(p.tried);
	if (!tried || tried.length === 0) return refusal("what was tried is required, as { text, link? } entries.");
	if (!isText(p.hypothesis)) return refusal("a hypothesis is required.");
	if (!options.some((o) => o.id === p.recommended)) return refusal(`the recommended option must be one of ${options.map((o) => o.id).join(", ")}.`);
	const texts = mode.strict ? strictTexts(p, options) : lenientTexts(p, options);
	if ("refused" in texts) return texts;
	const rationale = texts.rationale;
	return { where: neutralise(p.where), tried, hypothesis: texts.hypothesis, options: texts.options, recommended: p.recommended, ...(rationale ? { rationale } : {}) };
}

/** One past the highest `S<n>` among own stuck comments, reports and answers alike. */
export function nextStuckId(marked: MarkedComment[]): string {
	const numbers = marked.filter((m) => m.kind === STUCK_KIND).map((m) => Number(REPORT_ID.exec(m.id)?.[1] ?? 0));
	return `S${Math.max(0, ...numbers) + 1}`;
}

/** The stored report of `id`, when its data still has a valid shape. */
export function storedReport(marked: MarkedComment[], id: string): StuckReport | undefined {
	const m = marked.find((x) => x.kind === STUCK_KIND && x.id === id);
	const data = (typeof m?.data === "object" && m.data !== null ? m.data : undefined) as SpecStuckParams | undefined;
	if (!data) return undefined;
	const report = stuckReport(data, { strict: false });
	return "refused" in report ? undefined : report;
}

export function reportSummary(n: number, id: string, r: StuckReport): string {
	const tried = r.tried.map((t) => `- ${t.text}${t.link ? ` (${t.link})` : ""}`);
	return [
		`Stuck report ${id} on change #${n}.`,
		"",
		`Where: ${r.where}`,
		"Tried:",
		...tried,
		`Hypothesis: ${r.hypothesis}`,
		`Recommended: ${r.recommended}`,
	].join("\n");
}

/** The blocking `stuck:S<n>` request with the report's options. */
export function stuckRequest(state: ChangeState, id: string, report: StuckReport, now: Date): ApprovalRequest {
	const subject = stuckSubject(id);
	const snapshot: StuckSnapshot = { id };
	const summary = reportSummary(state.issue.number, id, report);
	const options = report.options.map((o) => (o.description === undefined ? { ...o, description: `Option ${o.id} of stuck report ${id}.` } : o));
	const briefing = { summary: report.hypothesis, recommended: report.recommended, rationale: report.rationale ?? `Recommended in stuck report ${id}.`, author: "agent" as const };
	const record = prepareRequest({ kind: "stuck", subject, mode: "blocking", options, head: state.git.head, body: "", snapshot, summary, now, briefing });
	const phase = state.phase.kind === "ok" ? state.phase.id : "";
	return { id: record.id, kind: "stuck", subject, record, change: state.issue.number, phase, summary: record.summary, links: [], files: [], mode: "blocking", options, briefing };
}

/**
 * What to send: a new report, or the open report again when it has no request pending or applying.
 * An open report with a request refuses a new one.
 */
export function stuckPlan(state: ChangeState, report: StuckReport): { id: string; report: StuckReport; write: boolean } | { refused: string } {
	const open = state.iterations.stuckOpen;
	if (open === undefined) return { id: nextStuckId(state.marked), report, write: true };
	const subject = stuckSubject(open);
	const requested = openRequestFor(state.requests, subject) !== undefined;
	const stored = storedReport(state.marked, open);
	if (requested || !stored) return refusal(`stuck report ${open} is unanswered; wait for the human's choice.`);
	return { id: open, report: stored, write: false };
}

// --- tool ----------------------------------------------------------------------------

async function send(w: WriteContext, state: ChangeState, plan: { id: string; report: StuckReport; write: boolean }, ctx: ApproverCtx): Promise<ToolResult<undefined>> {
	if (plan.write) await w.forge.createComment(state.issue.number, writeMarked(STUCK_KIND, plan.id, plan.report));
	const request = stuckRequest(state, plan.id, plan.report, new Date());
	const result = await sendRequest(w, state, request, ctx, { tool: TOOL, retry: `call spec_stuck again to send stuck report ${plan.id}` });
	return plan.write ? result : resentNote(plan.id, result);
}

/** The open report was sent again: the agent must know its new parameters were not used. */
export function resentNote(id: string, result: ToolResult<undefined>): ToolResult<undefined> {
	const note = `stuck report ${id} already exists and was sent again unchanged; the new parameters were not used.`;
	return toolResult(`${note}\n\n${result.content.map((c) => c.text).join("\n")}`, undefined, result.isError);
}

export async function runSpecStuck(p: SpecStuckParams, ctx: ApproverCtx): Promise<ToolResult<undefined>> {
	const report = stuckReport(p, { strict: true });
	if ("refused" in report) return toolResult(report.refused, undefined, true);
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, undefined, true);
	const change = requireChange(w.session);
	if (!change.ok) return toolResult(change.message, undefined, true);
	const plan = stuckPlan(change.state, report);
	if ("refused" in plan) return toolResult(plan.refused, undefined, true);
	return send(w, change.state, plan, ctx);
}

export function registerSpecStuck(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: "spec_stuck",
		label: "Send a livespec stuck report",
		description:
			"Report that the current livespec change is stuck: where the work stopped, what was tried (with links), a hypothesis (at most 600 characters), two or three options each with a short description (at most 200 characters), the recommended one and why (rationale, at most 600 characters). It writes a stuck report and asks the human to choose an option; the choice comes only from the human.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No choice parameter.
		parameters: {
			type: "object",
			properties: {
				where: { type: "string", description: "Where the work stopped" },
				tried: {
					type: "array",
					description: "What was tried, with links",
					items: { type: "object", properties: { text: { type: "string" }, link: { type: "string" } }, required: ["text"] },
				},
				hypothesis: { type: "string", description: "Why the work is stuck" },
				options: {
					type: "array",
					description: "Two or three ways forward",
					items: {
						type: "object",
						properties: { id: { type: "string" }, label: { type: "string" }, description: { type: "string", description: "What choosing this option means (one line, at most 200 characters)" } },
						required: ["id", "label", "description"],
					},
				},
				recommended: { type: "string", description: "The id of the recommended option" },
				rationale: { type: "string", description: "Why this option is recommended (at most 600 characters)" },
			},
			required: ["where", "tried", "hypothesis", "options", "recommended", "rationale"],
		} as never,
		execute: (_id, params, _signal, _update, ctx) => {
			const q = params as SpecStuckParams;
			return runSpecStuck({ where: q.where, tried: q.tried, hypothesis: q.hypothesis, options: q.options, recommended: q.recommended, rationale: q.rationale }, ctx as ApproverCtx);
		},
	});
}
