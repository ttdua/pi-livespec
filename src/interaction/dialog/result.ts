// Turns a submitted dialog state into the flow result, with the rules of the select flows
// (`in-session.ts`): empty notes approve, notes approve with notes, `changes` drops overrides.

import type { ApprovalRequest, Deferred, Outcome, Override } from "../approver.ts";
import { CANCELLED, type Cancelled, type Verdict } from "../flow-result.ts";
import type { DialogEntry, DialogModel } from "./model.ts";
import type { DialogState } from "./state.ts";

const sameTags = (a: string[], b: string[]): boolean => a.length === b.length && a.every((tag, i) => tag === b[i]);

/** The overrides that differ from the current values, in `model.units` order. */
export function overridesOf(model: DialogModel, state: DialogState): Override[] {
	const out: Override[] = [];
	for (const u of model.units) {
		const set = state.overrides[u.unit];
		if (set === undefined) continue;
		const override: Override = { unit: u.unit };
		if (set.difficulty !== undefined && set.difficulty !== u.difficulty) override.difficulty = set.difficulty;
		if (set.tags !== undefined && !sameTags(set.tags, u.tags)) override.tags = set.tags;
		if (override.difficulty !== undefined || override.tags !== undefined) out.push(override);
	}
	return out;
}

function questionVerdict(entry: DialogEntry, state: DialogState): Verdict {
	const answer = entry.action.kind === "candidate" ? entry.action.label : state.answer.trim();
	return { outcome: "approved", notes: "", answer };
}

/** The gate outcome of a picked entry: empty notes approve, notes approve with notes. */
const gateOutcome = (state: DialogState): "approved" | "approved_with_notes" => (state.notes.trim() === "" ? "approved" : "approved_with_notes");

const LABELS = { approved: "approved", approved_with_notes: "approved with notes", changes_requested: "changes requested" } as const;

/** The outcome text the review tab shows; the same rule `toResult` applies. `undefined` for questions and unpicked states. */
export function outcomeLabel(model: DialogModel, state: DialogState): string | undefined {
	const entry = state.picked === undefined ? undefined : model.entries[state.picked];
	if (entry === undefined || model.kind === "question") return undefined;
	if (entry.action.kind === "changes") return LABELS.changes_requested;
	if (model.kind === "choice") return LABELS.approved;
	return LABELS[gateOutcome(state)];
}

function gateVerdict(model: DialogModel, entry: DialogEntry, state: DialogState): Verdict {
	const notes = state.notes.trim();
	const outcome = gateOutcome(state);
	const verdict: Verdict = { outcome, notes };
	if (entry.action.kind === "option") verdict.choice = entry.action.id;
	const overrides = overridesOf(model, state);
	if (overrides.length > 0) verdict.overrides = overrides;
	return verdict;
}

/** The result of the picked entry; `CANCELLED` when nothing is picked or the entry dismisses. */
export function toResult(model: DialogModel, state: DialogState, r: ApprovalRequest): Verdict | Deferred | Cancelled {
	const entry = state.picked === undefined ? undefined : model.entries[state.picked];
	if (entry === undefined) return CANCELLED;
	const { action } = entry;
	if (action.kind === "dismiss") return CANCELLED;
	if (action.kind === "later") return { status: "deferred", questionClass: "non-blocking" };
	if (action.kind === "candidate" || action.kind === "own") return questionVerdict(entry, state);
	if (action.kind === "changes") return { outcome: "changes_requested", notes: state.notes.trim() };
	if (model.kind === "choice" && action.kind === "option") return { outcome: "approved", notes: "", choice: action.id };
	return gateVerdict(model, entry, state);
}
