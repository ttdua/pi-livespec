// The in-session adapter (design D5). In the pi TUI it asks the human through one
// custom dialog per request (`ui.dialog`); elsewhere, and when that dialog draws
// nothing, through `ui.select` and `ui.input`. Both are called by livespec code,
// and it uses only the values they return. A cancelled dialog is `dismissed`, never an approval.
//
// Every yes/no question is a `select` over explicit labels, never `ui.confirm`:
// `confirm` returns `false` both for "no" and for a cancelled dialog, so a
// cancel after "approve" would read as an approval. Every `select` maps the
// returned display label back through an explicit menu table; identity is never
// inferred from a raw request label.

import type {
	ApprovalRequest,
	Approver,
	ApproverUI,
	Deferred,
	Difficulty,
	Outcome,
	Override,
} from "./approver.ts";
import { gateChoices } from "./describe-actions.ts";
import { createDialog } from "./dialog/host.ts";
import { CANCELLED, type Cancelled, type Verdict } from "./flow-result.ts";
import { ENTRY_LABELS, type MenuEntry, menuEntries, titleWithBriefing } from "./menu.ts";

const DIFFICULTIES: Difficulty[] = ["low", "medium", "high"];

const DISMISSED: Verdict = { outcome: "dismissed", notes: "" };

/**
 * Shows `entries` and returns the value of the picked label. A cancel, or a label
 * that is not in the table, is `CANCELLED`.
 */
async function choose<T>(ui: ApproverUI, title: string, entries: readonly MenuEntry<T>[]): Promise<T | Cancelled> {
	const table = displayTable(entries);
	const picked = await ui.select(title, [...table.keys()]);
	return picked !== undefined && table.has(picked) ? (table.get(picked) as T) : CANCELLED;
}

/**
 * Builds the label → value table by position. A label that collides with an
 * earlier one (a built-in or another option) gets ` (2)`, ` (3)`, … until it is
 * unique, so no entry is ever dropped or shadowed.
 */
function displayTable<T>(entries: readonly MenuEntry<T>[]): Map<string, T> {
	const table = new Map<string, T>();
	for (const [label, value] of entries) {
		let display = label;
		for (let n = 2; table.has(display); n++) display = `${label} (${n})`;
		table.set(display, value);
	}
	return table;
}

/** Entries whose label is the value itself, deduplicated. */
function plainEntries(values: string[]): MenuEntry<string>[] {
	return [...new Set(values)].map((v) => [v, v] as const);
}

async function ask(ui: ApproverUI, title: string, placeholder?: string): Promise<string | Cancelled> {
	const text = await ui.input(title, placeholder);
	return text === undefined ? CANCELLED : text.trim();
}

/** "No notes" gives empty notes; "Add notes" opens an input. */
async function optionalNotes(ui: ApproverUI): Promise<string | Cancelled> {
	const wantsNotes = await choose(ui, "Add notes?", [
		["No notes", false],
		["Add notes", true],
	]);
	if (wantsNotes === CANCELLED) return CANCELLED;
	return wantsNotes ? ask(ui, "Notes") : "";
}

/** Asks for per-unit Difficulty and Tags overrides until the human picks "done". */
async function collectOverrides(ui: ApproverUI, units: string[]): Promise<Override[] | Cancelled> {
	const wantsAdjust = await choose(ui, "Adjust Difficulty or Tags?", [
		["Keep classification", false],
		["Adjust Difficulty or Tags", true],
	]);
	if (wantsAdjust === CANCELLED) return CANCELLED;
	if (!wantsAdjust) return [];

	const byUnit = new Map<string, Override>();
	const unitMenu: MenuEntry<string | undefined>[] = [...plainEntries(units), ["done", undefined]];
	for (;;) {
		const unit = await choose(ui, "Unit to adjust", unitMenu);
		if (unit === CANCELLED) return CANCELLED;
		if (unit === undefined) return [...byUnit.values()];
		const change = await askOverrideField(ui, unit);
		if (change === CANCELLED) return CANCELLED;
		byUnit.set(unit, { ...(byUnit.get(unit) ?? { unit }), ...change });
	}
}

async function askOverrideField(
	ui: ApproverUI,
	unit: string,
): Promise<{ difficulty: Difficulty } | { tags: string[] } | Cancelled> {
	const field = await choose(ui, `Field of ${unit}`, [
		["difficulty", "difficulty"],
		["tags", "tags"],
	] as const);
	if (field === CANCELLED) return CANCELLED;
	if (field === "difficulty") {
		const value = await choose(ui, `Difficulty of ${unit}`, plainEntries(DIFFICULTIES) as MenuEntry<Difficulty>[]);
		return value === CANCELLED ? CANCELLED : { difficulty: value };
	}
	const value = await ask(ui, `Tags of ${unit}`, "a, b");
	if (value === CANCELLED) return CANCELLED;
	return { tags: value.split(",").map((tag) => tag.trim()).filter((tag) => tag !== "") };
}

type GateAction = { action: "approve" } | { action: "changes" } | { action: "dismiss" } | { action: "option"; id: string };

/** The recommended choice's label, so the title can name what the briefing recommends. */
function recommendedLabel(r: ApprovalRequest, choices: { id: string; label: string }[]): string | undefined {
	return choices.find((c) => c.id === r.briefing?.recommended)?.label;
}

function gateAction(id: string): GateAction {
	return id === "approve" || id === "changes" || id === "dismiss" ? { action: id } : { action: "option", id };
}

/**
 * Gate and amendment requests: approve, request changes, dismiss, or one of the request's options (e.g.
 * `waive`). Plain approve is not offered while waivable checks fail.
 */
async function gateFlow(ui: ApproverUI, r: ApprovalRequest): Promise<Verdict | Cancelled> {
	const choices = gateChoices(r);
	const entries = menuEntries(
		choices.map((c) => ({ ...c, value: gateAction(c.id) })),
		r.briefing?.recommended,
	);
	const selected = await choose<GateAction>(ui, titleWithBriefing(r, recommendedLabel(r, choices)), entries);
	if (selected === CANCELLED || selected.action === "dismiss") return CANCELLED;
	if (selected.action === "changes") {
		const notes = await ask(ui, "Requested changes");
		return notes === CANCELLED || notes === "" ? CANCELLED : { outcome: "changes_requested", notes };
	}
	const notes = await optionalNotes(ui);
	if (notes === CANCELLED) return CANCELLED;
	const outcome: Outcome = notes === "" ? "approved" : "approved_with_notes";
	const verdict: Verdict = { outcome, notes };
	if (selected.action === "option") verdict.choice = selected.id;
	if (r.overridable) {
		const overrides = await collectOverrides(ui, r.overridable.units);
		if (overrides === CANCELLED) return CANCELLED;
		if (overrides.length > 0) verdict.overrides = overrides;
	}
	return verdict;
}

type RequirementPick = { kind: "none" } | { kind: "requirement"; name: string } | { kind: "other" };

/** Does the answer change a requirement: no, one of the declared requirements, or a typed one. */
async function askChangedRequirement(ui: ApproverUI, requirements: string[]): Promise<string | undefined | Cancelled> {
	const selected = await choose<RequirementPick>(ui, "Does the answer change a requirement?", [
		["no", { kind: "none" }],
		...plainEntries(requirements).map(([label, name]) => [label, { kind: "requirement", name }] as const),
		["other", { kind: "other" }],
	]);
	if (selected === CANCELLED) return CANCELLED;
	if (selected.kind === "none") return undefined;
	if (selected.kind === "requirement") return selected.name;
	const typed = await ask(ui, "Changed requirement", "<capability>/Requirement: <name>");
	return typed === CANCELLED || typed === "" ? CANCELLED : typed;
}

/** What the human does with a question: pick a candidate, type an answer, or answer later. */
type QuestionStep = { kind: "candidate"; label: string } | { kind: "own" } | { kind: "later" };

async function askQuestionStep(ui: ApproverUI, r: ApprovalRequest): Promise<QuestionStep | Cancelled> {
	const options = r.options ?? [];
	const title = titleWithBriefing(r, recommendedLabel(r, options));
	if (options.length === 0) {
		return choose<QuestionStep>(ui, title, [
			[ENTRY_LABELS.answerNow, { kind: "own" }],
			[ENTRY_LABELS.later, { kind: "later" }],
		]);
	}
	const candidates = menuEntries(
		options.map((o) => ({ ...o, value: { kind: "candidate", label: o.label } as QuestionStep })),
		r.briefing?.recommended,
	);
	return choose<QuestionStep>(ui, title, [
		...candidates,
		[ENTRY_LABELS.own, { kind: "own" }],
		[ENTRY_LABELS.later, { kind: "later" }],
	]);
}

async function questionFlow(ui: ApproverUI, r: ApprovalRequest): Promise<Verdict | Deferred | Cancelled> {
	const step = await askQuestionStep(ui, r);
	if (step === CANCELLED) return CANCELLED;
	if (step.kind === "later") return { status: "deferred", questionClass: "non-blocking" };
	const answer = step.kind === "candidate" ? step.label : await ask(ui, "Answer");
	if (answer === CANCELLED || answer === "") return CANCELLED;
	const changed = await askChangedRequirement(ui, r.question?.requirements ?? []);
	if (changed === CANCELLED) return CANCELLED;
	const verdict: Verdict = { outcome: "approved", notes: "", answer };
	if (changed !== undefined) verdict.changesRequirement = changed;
	if (r.question) verdict.questionClass = r.question.class;
	return verdict;
}

/** Stuck and decide requests: a choice among the request's options. */
async function choiceFlow(ui: ApproverUI, r: ApprovalRequest): Promise<Verdict | Cancelled> {
	const options = r.options ?? [];
	const entries = menuEntries(
		options.map((o) => ({ ...o, value: o.id })),
		r.briefing?.recommended,
	);
	const id = await choose(ui, titleWithBriefing(r, recommendedLabel(r, options)), entries);
	return id === CANCELLED ? CANCELLED : { outcome: "approved", notes: "", choice: id };
}

function flowFor(r: ApprovalRequest): (ui: ApproverUI, r: ApprovalRequest) => Promise<Verdict | Deferred | Cancelled> {
	if (r.kind === "question") return questionFlow;
	if (r.kind === "stuck" || r.subject.startsWith("decide:")) return choiceFlow;
	return gateFlow;
}

/**
 * One dialog for `r` where the host draws it (design D2). An explicit cancel is `CANCELLED`; a dialog
 * that resolves `undefined` drew nothing, so the `select` chain asks the same request instead.
 */
async function askHuman(ui: ApproverUI, r: ApprovalRequest): Promise<Verdict | Deferred | Cancelled> {
	const out = ui.dialog === undefined ? undefined : await ui.dialog(createDialog(r));
	if (out === undefined) return flowFor(r)(ui, r);
	return out.kind === "cancelled" ? CANCELLED : out.result;
}

/** `login` resolves the current forge login, recorded as `by`. */
export function createInSessionApprover(ui: ApproverUI, login: () => Promise<string>): Approver {
	return {
		name: "in-session",
		available: () => ui.hasUI,
		async request(r) {
			const result = await askHuman(ui, r);
			if (result !== CANCELLED && "status" in result) return result;
			const verdict = result === CANCELLED ? DISMISSED : result;
			return { status: "answered", ...verdict, by: await login(), at: new Date().toISOString(), adapter: "in-session" };
		},
	};
}
