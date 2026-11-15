// The in-session adapter (design D5). It asks the human through `ui.select` and
// `ui.input`, called by livespec code, and uses only the values those calls
// return. A cancelled dialog is `dismissed`, never an approval.
//
// Every yes/no question is a `select` over explicit labels, never `ui.confirm`:
// `confirm` returns `false` both for "no" and for a cancelled dialog, so a
// cancel after "approve" would read as an approval. Every `select` maps the
// returned display label back through an explicit menu table; identity is never
// inferred from a raw request label.

import type {
	Answered,
	ApprovalRequest,
	Approver,
	ApproverUI,
	Deferred,
	Difficulty,
	Outcome,
	Override,
	RequestOption,
} from "./approver.ts";

const DIFFICULTIES: Difficulty[] = ["low", "medium", "high"];

/** Returned when the human cancels any dialog; the request turns into `dismissed`. */
const CANCELLED = Symbol("cancelled");
type Cancelled = typeof CANCELLED;

/** The answer fields a flow decides; `by`, `at` and `adapter` are added by the adapter. */
type Verdict = Omit<Answered, "status" | "by" | "at" | "adapter">;

const DISMISSED: Verdict = { outcome: "dismissed", notes: "" };

/** One select entry: the label shown to the human and the value it stands for. */
type MenuEntry<T> = readonly [label: string, value: T];

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

/** Request options are shown as `<label> [<id>]`; `choose` makes any remaining collision unique by position. */
function optionEntries<T>(options: RequestOption[], wrap: (o: RequestOption) => T): MenuEntry<T>[] {
	return options.map((o) => [`${o.label} [${o.id}]`, wrap(o)] as const);
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

/** Failing waivable checks of a gate request; a plain approve cannot pass them, only `waive`. */
function failingWaivable(r: ApprovalRequest): string[] {
	if (r.kind !== "gate") return [];
	const list = (r.record.snapshot as { failingWaivable?: unknown }).failingWaivable;
	return Array.isArray(list) ? list.map(String) : [];
}

/**
 * Gate and amendment requests: approve, request changes, dismiss, or one of the request's options (e.g.
 * `waive`). Plain approve is not offered while waivable checks fail.
 */
async function gateFlow(ui: ApproverUI, r: ApprovalRequest): Promise<Verdict | Cancelled> {
	const approve: MenuEntry<GateAction>[] = failingWaivable(r).length > 0 ? [] : [["approve", { action: "approve" }]];
	const selected = await choose<GateAction>(ui, r.summary, [
		...approve,
		["request changes", { action: "changes" }],
		["dismiss", { action: "dismiss" }],
		...optionEntries<GateAction>(r.options ?? [], (o) => ({ action: "option", id: o.id })),
	]);
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

async function questionFlow(ui: ApproverUI, r: ApprovalRequest): Promise<Verdict | Deferred | Cancelled> {
	const answerNow = await choose(ui, r.summary, [
		["answer now", true],
		["answer later (non-blocking)", false],
	]);
	if (answerNow === CANCELLED) return CANCELLED;
	if (!answerNow) return { status: "deferred", questionClass: "non-blocking" };
	const answer = await ask(ui, "Answer");
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
	const id = await choose(ui, r.summary, optionEntries(r.options ?? [], (o) => o.id));
	return id === CANCELLED ? CANCELLED : { outcome: "approved", notes: "", choice: id };
}

function flowFor(r: ApprovalRequest): (ui: ApproverUI, r: ApprovalRequest) => Promise<Verdict | Deferred | Cancelled> {
	if (r.kind === "question") return questionFlow;
	if (r.kind === "stuck" || r.subject.startsWith("decide:")) return choiceFlow;
	return gateFlow;
}

/** `login` resolves the current forge login, recorded as `by`. */
export function createInSessionApprover(ui: ApproverUI, login: () => Promise<string>): Approver {
	return {
		name: "in-session",
		available: () => ui.hasUI,
		async request(r) {
			const result = await flowFor(r)(ui, r);
			if (result !== CANCELLED && "status" in result) return result;
			const verdict = result === CANCELLED ? DISMISSED : result;
			return { status: "answered", ...verdict, by: await login(), at: new Date().toISOString(), adapter: "in-session" };
		},
		poll: async () => ({ status: "pending" }),
	};
}
