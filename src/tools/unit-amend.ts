// `unit_amend` (design D9a, unit-planning "Unit amendments"): after the plan is
// locked, edits, adds or drops one unit through a light gate request that shows
// only the affected unit. A pure planner builds the amendment snapshot, with the
// classification of an edited or added unit, and validates the whole resulting
// plan before any request is sent. Completion applies it (`complete-amend.ts`).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatResults } from "../commands/validate.ts";
import { messageOf } from "../core/messages.ts";
import { parseChange, type Unit } from "../core/change.ts";
import { unitDigest } from "../core/digest.ts";
import type { UnitInput } from "../core/unit-blocks.ts";
import { renderUnit } from "../core/unit-blocks.ts";
import { checkDoneMapsScenarios, validateUnits } from "../core/validate-units.ts";
import type { Pack } from "../engine/pack-types.ts";
import type { ChangeState } from "../engine/state-types.ts";
import type { MarkedComment } from "../forge/markers.ts";
import { untrusted } from "../hooks/phase-card.ts";
import { amendedBody } from "../interaction/amend-body.ts";
import { type AmendSnapshot, ANSWER_KIND, type ApprovalRequest } from "../interaction/approver.ts";
import { allRequests, prepareRequest } from "../interaction/requests.ts";
import type { ApproverCtx } from "./approver-for.ts";
import { blockingStateRefusal } from "../engine/gates.ts";
import { blockingRequests } from "../engine/request-mode.ts";
import { classifyUnits, normalizeUnitInput } from "./classify-units.ts";
import { createDecisionAsker, type DecisionAsker } from "./decide-ask.ts";
import { prepareWrite, requireChange, type ToolResult, toolResult } from "./guard.ts";
import { registerLivespecTool } from "./register.ts";
import { sendRequest } from "./request-flow.ts";

export type UnitAmendParams = { unit?: string; add?: boolean; drop?: boolean; replacement?: UnitInput };

/** The three accepted forms of a call. */
export type AmendForm = { action: "edit"; unit: string; replacement: UnitInput } | { action: "add"; replacement: UnitInput } | { action: "drop"; unit: string };

export type AmendPlan = { snapshot: AmendSnapshot; summary: string };

const TOOL = "unit_amend";
const AMEND_PREFIX = "amend:";
const FORMS = "Call unit_amend as { unit, replacement } to edit, { add: true, replacement } to add, or { drop: true, unit } to drop.";

const refusal = (message: string): { refused: string } => ({ refused: `${TOOL} refused: ${message}` });

// --- pure planning -------------------------------------------------------------------

/** Exactly one of the three forms; any other combination of parameters is refused. */
export function amendForm(p: UnitAmendParams): AmendForm | { refused: string } {
	const unit = typeof p.unit === "string" && p.unit !== "" ? p.unit : undefined;
	const hasReplacement = p.replacement !== undefined && p.replacement !== null;
	const add = p.add === true;
	const drop = p.drop === true;
	if (add && !drop && unit === undefined && hasReplacement) return { action: "add", replacement: normalizeUnitInput(p.replacement) };
	if (drop && !add && unit !== undefined && !hasReplacement) return { action: "drop", unit };
	if (!add && !drop && unit !== undefined && hasReplacement) return { action: "edit", unit, replacement: normalizeUnitInput(p.replacement) };
	return refusal(FORMS);
}

/** Refusals that hold whatever the form: no lock yet, a blocking state, or a blocking request pending or applying. */
export function stateRefusal(state: ChangeState): { refused: string } | undefined {
	if (state.lock.locked === undefined) return refusal("the plan is not locked yet; write units with plan_units before the plan gate.");
	const blockingState = blockingStateRefusal(state);
	if (blockingState !== undefined) return refusal(blockingState);
	const blocking = blockingRequests(state).map((r) => r.subject);
	if (blocking.length > 0) return refusal(`a blocking request is pending (${blocking.map(untrusted).join(", ")}); wait for its answer.`);
	return undefined;
}

const UNIT_ID = /^U(\d+)$/;

/**
 * Unit ids named by own comments: decision subjects, amendment units and locked digests, so a dropped id stays taken.
 * The answer of a rule ask (a `decision` naming its `request`) reserves no id, so an add that asked a human keeps its id on rerun.
 */
export function historyUnitIds(marked: MarkedComment[]): string[] {
	const ids: string[] = [];
	for (const m of marked) {
		const d = (typeof m.data === "object" && m.data !== null ? m.data : {}) as Record<string, unknown>;
		if (m.kind === "decision" && typeof d.subject === "string" && typeof d.request !== "string") ids.push(d.subject);
		if (m.kind === "amendment" && typeof d.unit === "string") ids.push(d.unit);
		if (m.kind === "gate" && typeof d.locked === "object" && d.locked !== null) ids.push(...Object.keys(d.locked));
	}
	return ids;
}

/** The next free unit id: one past the highest `U<n>` in the body or the history, so an id is never reused. */
export function nextUnitId(units: Unit[], history: string[] = []): string {
	const numbers = [...units.map((u) => u.id), ...history].map((id) => Number(UNIT_ID.exec(id)?.[1] ?? 0));
	return `U${Math.max(0, ...numbers) + 1}`;
}

function dropRefusal(units: Unit[], target: Unit): { refused: string } | undefined {
	if (target.done) return refusal(`${target.id} is done; a done unit cannot be dropped.`);
	const dependents = units.filter((u) => u.id !== target.id && u.depends.includes(target.id)).map((u) => u.id);
	if (dependents.length > 0) return refusal(`${dependents.join(", ")} ${dependents.length === 1 ? "depends" : "depend"} on ${target.id}; amend ${dependents.length === 1 ? "it" : "them"} to drop the dependency first.`);
	return undefined;
}

/** The snapshot of an edit or add: the classified, rendered unit; an edit keeps the unit's status line. */
async function contractSnapshot(form: Exclude<AmendForm, { action: "drop" }>, units: Unit[], history: string[], decisions: Pack["decisions"], ask?: DecisionAsker): Promise<AmendSnapshot | { refused: string }> {
	const existing = form.action === "edit" ? units.find((u) => u.id === form.unit) : undefined;
	if (form.action === "edit" && !existing) return refusal(`${form.unit} is not in the body.`);
	const id = existing?.id ?? nextUnitId(units, history);
	let classified: Awaited<ReturnType<typeof classifyUnits>>;
	try {
		classified = await classifyUnits([{ id, input: form.replacement }], decisions, ask);
	} catch (error) {
		return refusal(`${messageOf(error)}; no request was sent.`);
	}
	if (classified.status !== "classified") return refusal(`decision \`${classified.point}.${classified.subject}\` waits for a human answer (request ${classified.requestId}); no amendment request was sent.`);
	const lines = renderUnit(classified.units[0]!);
	if (existing && existing.statusText !== "") lines[lines.length - 1] = existing.statusText;
	const snapshot: AmendSnapshot = { action: form.action, unit: id, lines, records: classified.records };
	if (existing) Object.assign(snapshot, { oldDigest: unitDigest(existing), oldDone: existing.done });
	return snapshot;
}

/** The current block of `unit`, heading to status line. */
function blockOf(body: string, unit: Unit): string[] {
	return parseChange(body).lines.slice(unit.startLine, unit.endLine + 1).map((l) => l.text);
}

const SEPARATOR = "--- becomes ---";

/** Only the affected unit: an edit shows the old block, a separator, then the new block. */
function summaryOf(n: number, s: AmendSnapshot, current: string[] | undefined): string {
	const head = (verb: string) => [`${verb} ${s.unit} in change #${n}:`, ""];
	if (s.action === "edit") return [...head("Replace"), ...(current ?? []), "", SEPARATOR, "", ...(s.lines ?? [])].join("\n");
	if (s.action === "add") return [...head("Add"), ...(s.lines ?? [])].join("\n");
	return [...head("Drop"), ...(current ?? [])].join("\n");
}

/** The resulting plan must pass the LS-02 unit validators. */
function planErrors(body: string, s: AmendSnapshot): string | undefined {
	const after = parseChange(amendedBody(body, s));
	const errors = [...validateUnits(after), ...checkDoneMapsScenarios(after)].filter((r) => r.severity === "error");
	return errors.length === 0 ? undefined : `${TOOL} refused: the amended plan is invalid, so no request was sent.\n${formatResults(errors)}`;
}

/** Builds and validates the amendment; nothing is sent or written. */
export async function planAmend(state: ChangeState, body: string, form: AmendForm, decisions: Pack["decisions"], ask?: DecisionAsker): Promise<AmendPlan | { refused: string }> {
	const units = parseChange(body).units;
	let snapshot: AmendSnapshot | { refused: string };
	if (form.action === "drop") {
		const target = units.find((u) => u.id === form.unit);
		if (!target) return refusal(`${form.unit} is not in the body.`);
		const refused = dropRefusal(units, target);
		if (refused) return refused;
		snapshot = { action: "drop", unit: target.id, oldDigest: unitDigest(target), oldDone: target.done, records: [] };
	} else {
		snapshot = await contractSnapshot(form, units, historyUnitIds(state.marked), decisions, ask);
	}
	if ("refused" in snapshot) return snapshot;
	const invalid = planErrors(body, snapshot);
	if (invalid) return { refused: invalid };
	const target = units.find((u) => u.id === snapshot.unit);
	return { snapshot, summary: summaryOf(state.issue.number, snapshot, target ? blockOf(body, target) : undefined) };
}

/**
 * `amend:<n>`, one past the number of distinct amendment requests the issue has seen: forge requests leave a
 * `request` comment, in-session answers only an `answer` comment carrying the request.
 */
export function amendSubject(state: ChangeState): string {
	const ids = new Set(allRequests(state.marked).filter((r) => r.subject.startsWith(AMEND_PREFIX)).map((r) => r.id));
	for (const m of state.marked) {
		const subject = m.kind === ANSWER_KIND ? (m.data as { request?: { subject?: unknown } } | null)?.request?.subject : undefined;
		if (typeof subject === "string" && subject.startsWith(AMEND_PREFIX)) ids.add(m.id);
	}
	return `${AMEND_PREFIX}${ids.size + 1}`;
}

/** The light gate request: only the affected unit, with its classification overridable unless it is dropped. */
export function amendRequest(state: ChangeState, plan: AmendPlan, body: string, now: Date): ApprovalRequest {
	const subject = amendSubject(state);
	const record = prepareRequest({ kind: "gate", subject, mode: "blocking", head: state.git.head, body, snapshot: plan.snapshot, summary: plan.summary, now });
	const phase = state.phase.kind === "ok" ? state.phase.id : "";
	const request: ApprovalRequest = { id: record.id, kind: "gate", subject, record, change: state.issue.number, phase, summary: plan.summary, links: [], files: [], mode: "blocking" };
	if (plan.snapshot.action !== "drop") request.overridable = { units: [plan.snapshot.unit] };
	return request;
}

// --- tool ----------------------------------------------------------------------------

export async function runUnitAmend(p: UnitAmendParams, ctx: ApproverCtx): Promise<ToolResult<undefined>> {
	const w = await prepareWrite();
	if (!w.ok) return toolResult(w.message, undefined, true);
	const change = requireChange(w.session);
	if (!change.ok) return toolResult(change.message, undefined, true);
	const { state } = change;
	const form = amendForm(p);
	if ("refused" in form) return toolResult(form.refused, undefined, true);
	const blocked = stateRefusal(state);
	if (blocked) return toolResult(blocked.refused, undefined, true);
	const body = (await w.forge.getIssue(state.issue.number)).body;
	const plan = await planAmend(state, body, form, w.pack.decisions, createDecisionAsker(w, state, ctx));
	if ("refused" in plan) return toolResult(plan.refused, undefined, true);
	const request = amendRequest(state, plan, body, new Date());
	return sendRequest(w, state, request, ctx, { tool: TOOL, retry: "run unit_amend again" });
}

const UNIT_INPUT_SCHEMA = {
	type: "object",
	description: "The full unit, without Difficulty or Tags",
	properties: {
		title: { type: "string" },
		covers: { type: "array", items: { type: "string" } },
		files: { type: "array", items: { type: "string" } },
		done_means: { type: "array", items: { type: "object", properties: { label: { type: "string" }, text: { type: "string" } }, required: ["label", "text"] } },
		scenarios: { type: "array", items: { type: "object", properties: { label: { type: "string" }, ref: { type: "string" } }, required: ["label", "ref"] } },
		depends: { type: "array", items: { type: "string" } },
		verify: { type: "string" },
		kind: { type: "string", enum: ["refactor"] },
		extra_tags: { type: "array", items: { type: "string" }, description: "Kebab-case tags to add; they can only add" },
	},
	required: ["title", "covers", "files", "done_means", "scenarios", "depends", "verify"],
};

export function registerUnitAmend(pi: ExtensionAPI): void {
	registerLivespecTool(pi, {
		name: "unit_amend",
		label: "Amend a locked livespec unit",
		description:
			"After the plan is locked, change one unit through a light human gate: { unit, replacement } edits it, { add: true, replacement } adds a unit with the next id, { drop: true, unit } drops a unit that is not done. Difficulty and Tags are computed by rule; the outcome comes only from the human.",
		// Plain JSON-schema literal; cast avoids a typebox dependency. No outcome, Difficulty or Tags parameter.
		parameters: {
			type: "object",
			properties: {
				unit: { type: "string", description: "The unit id (U<n>) to edit or drop" },
				add: { type: "boolean", description: "Add a new unit" },
				drop: { type: "boolean", description: "Drop the unit" },
				replacement: UNIT_INPUT_SCHEMA,
			},
		} as never,
		execute: (_id, params, _signal, _update, ctx) => {
			const q = params as UnitAmendParams;
			return runUnitAmend({ unit: q.unit, add: q.add, drop: q.drop, replacement: q.replacement } as UnitAmendParams, ctx as ApproverCtx);
		},
	});
}
