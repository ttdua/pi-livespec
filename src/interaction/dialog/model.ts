// The dialog model: what a request shows (tabs, entries, units) and, in `result.ts`, the flow result
// a submitted state stands for. Pure. Agent text is sanitised here, so the view never sees raw text.

import type { ApprovalRequest, Briefing, Difficulty, RequestOption } from "../approver.ts";
import { type GateChoice, gateChoices } from "../describe-actions.ts";
import { BRIEFING_HEADING, briefingLines, ENTRY_LABELS, orderRecommended } from "../menu.ts";
import { failingWaivableOf } from "../waive-rule.ts";
import { sanitize } from "./sanitize.ts";

export type DialogKind = "gate" | "question" | "choice";
export type TabName = "decision" | "behavior" | "units" | "review";

export type DialogEntryAction =
	| { kind: "approve" }
	| { kind: "changes" }
	| { kind: "dismiss" }
	| { kind: "option"; id: string }
	| { kind: "candidate"; label: string }
	| { kind: "own" }
	| { kind: "later" };

export type DialogEntry = { label: string; description?: string; recommended: boolean; action: DialogEntryAction };

export type DialogModel = {
	kind: DialogKind;
	/** Tabs shown before the units tab is opened; `tabsOf` (state.ts) adds it once opened. */
	tabs: TabName[];
	unitsAvailable: boolean;
	behaviorAvailable: boolean;
	facts: string;
	status: { symbol: "✓" | "!" | "✗"; text: string }[];
	briefing?: { heading: string; lines: string[] };
	entries: DialogEntry[];
	units: { unit: string; label: string; difficulty?: Difficulty; tags: string[] }[];
	/** `capability` stays the raw id (it is the override key); only `label` is sanitised. */
	behavior: { capability: string; label: string; outcome: "unchanged" | "changed" | null }[];
	notes: boolean;
};

export { markedBehavior, outcomeLabel, overridesOf, toResult } from "./result.ts";

/** Same classification as the select flows: questions, stuck reports and `decide:` asks, else a gate. */
function kindOf(r: ApprovalRequest): DialogKind {
	if (r.kind === "question") return "question";
	return r.kind === "stuck" || r.subject.startsWith("decide:") ? "choice" : "gate";
}

const clean = (text: string | undefined): string | undefined => (text === undefined || text === "" ? undefined : sanitize(text));

function entry(label: string, action: DialogEntryAction, o: { description?: string; recommended?: boolean } = {}): DialogEntry {
	const description = clean(o.description);
	return { label: sanitize(label), ...(description === undefined ? {} : { description }), recommended: o.recommended ?? false, action };
}

function gateAction(id: string): DialogEntryAction {
	return id === "approve" || id === "changes" || id === "dismiss" ? { kind: id } : { kind: "option", id };
}

function gateEntries(r: ApprovalRequest, choices: GateChoice[]): DialogEntry[] {
	return orderRecommended(choices, r.briefing?.recommended).map((c) =>
		entry(c.label, gateAction(c.id), { description: c.description, recommended: c.id === r.briefing?.recommended }),
	);
}

function optionEntries(r: ApprovalRequest, options: RequestOption[], action: (o: RequestOption) => DialogEntryAction): DialogEntry[] {
	return orderRecommended(options, r.briefing?.recommended).map((o) =>
		entry(o.label, action(o), { ...(o.description === undefined ? {} : { description: o.description }), recommended: o.id === r.briefing?.recommended }),
	);
}

function questionEntries(r: ApprovalRequest): DialogEntry[] {
	const candidates = optionEntries(r, r.options ?? [], (o) => ({ kind: "candidate", label: o.label }));
	return [...candidates, entry(ENTRY_LABELS.own, { kind: "own" }), entry(ENTRY_LABELS.later, { kind: "later" })];
}

function entriesOf(r: ApprovalRequest, kind: DialogKind, choices: GateChoice[]): DialogEntry[] {
	if (kind === "question") return questionEntries(r);
	if (kind === "choice") return optionEntries(r, r.options ?? [], (o) => ({ kind: "option", id: o.id }));
	return gateEntries(r, choices);
}

function briefingOf(b: Briefing | undefined, labels: { id: string; label: string }[]): DialogModel["briefing"] {
	if (b === undefined) return undefined;
	const label = labels.find((c) => c.id === b.recommended)?.label;
	return { heading: BRIEFING_HEADING[b.author], lines: briefingLines(b, label).slice(1).flatMap((l) => sanitize(l).split("\n")) };
}

function statusOf(r: ApprovalRequest): DialogModel["status"] {
	return failingWaivableOf(r.record.snapshot).map((check) => ({ symbol: "!" as const, text: `${sanitize(check)} fails (waivable)` }));
}

type Current = NonNullable<ApprovalRequest["overridable"]>["current"];

/** Sanitised, comma-free (a comma would be split by the tags editor), trimmed, non-empty tags: the form the tags editor parses back, so an unchanged prefill is no override. */
const cleanTags = (tags: string[]): string[] => tags.map((t) => sanitize(t).replaceAll(",", "").trim()).filter((t) => t !== "");

/** The current values of `unit`: its difficulty when set and its cleaned tags. */
function currentOf(current: Current, unit: string): { difficulty?: Difficulty; tags: string[] } {
	const values = current?.[unit];
	return { ...(values?.difficulty === undefined ? {} : { difficulty: values.difficulty }), tags: cleanTags(values?.tags ?? []) };
}

/** `unit` stays the raw id (it is the override key); only `label` is sanitised for display. */
function unitsOf(r: ApprovalRequest): DialogModel["units"] {
	const { units = [], current } = r.overridable ?? {};
	return units.map((unit) => ({ unit, label: sanitize(unit), ...currentOf(current, unit) }));
}

function behaviorOf(r: ApprovalRequest): DialogModel["behavior"] {
	return (r.overridableBehavior?.items ?? []).map((i) => ({ capability: i.capability, label: sanitize(i.capability), outcome: i.outcome }));
}

/** The tabs, entries and units a request shows; entry order matches the select flows. */
export function buildModel(r: ApprovalRequest): DialogModel {
	const kind = kindOf(r);
	const choices = kind === "gate" ? gateChoices(r) : [];
	const labelled = kind === "gate" ? choices : (r.options ?? []);
	const briefing = briefingOf(r.briefing, labelled);
	return {
		kind,
		tabs: ["decision", "review"],
		unitsAvailable: r.overridable !== undefined,
		behaviorAvailable: r.overridableBehavior !== undefined,
		facts: sanitize(r.summary),
		status: statusOf(r),
		...(briefing === undefined ? {} : { briefing }),
		entries: entriesOf(r, kind, choices),
		units: unitsOf(r),
		behavior: behaviorOf(r),
		notes: kind === "gate",
	};
}
