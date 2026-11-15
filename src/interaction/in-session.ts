// The in-session adapter (design D5). It asks the human through `ui.select`,
// `ui.confirm` and `ui.input`, called by livespec code, and uses only the values
// those calls return. A cancelled dialog is `dismissed`, never an approval.

import type {
	Answered,
	ApprovalRequest,
	Approver,
	ApproverUI,
	Deferred,
	Difficulty,
	Outcome,
	Override,
} from "./approver.ts";

const APPROVE = "approve";
const REQUEST_CHANGES = "request changes";
const DISMISS = "dismiss";
const ANSWER_NOW = "answer now";
const ANSWER_LATER = "answer later (non-blocking)";
const NO_CHANGE = "no";
const OTHER = "other";
const DONE = "done";
const DIFFICULTY_FIELD = "difficulty";
const TAGS_FIELD = "tags";
const DIFFICULTIES: Difficulty[] = ["low", "medium", "high"];

/** Returned when the human cancels any dialog; the request turns into `dismissed`. */
const CANCELLED = Symbol("cancelled");
type Cancelled = typeof CANCELLED;

/** The answer fields a flow decides; `by`, `at` and `adapter` are added by the adapter. */
type Verdict = Omit<Answered, "status" | "by" | "at" | "adapter">;

const DISMISSED: Verdict = { outcome: "dismissed", notes: "" };

async function pick(ui: ApproverUI, title: string, options: string[]): Promise<string | Cancelled> {
	const choice = await ui.select(title, options);
	return choice === undefined || !options.includes(choice) ? CANCELLED : choice;
}

async function ask(ui: ApproverUI, title: string, placeholder?: string): Promise<string | Cancelled> {
	const text = await ui.input(title, placeholder);
	return text === undefined ? CANCELLED : text.trim();
}

/** "Add notes?" then the notes; declining gives empty notes. */
async function optionalNotes(ui: ApproverUI): Promise<string | Cancelled> {
	if (!(await ui.confirm("Add notes?", "Add notes to this answer?"))) return "";
	return ask(ui, "Notes");
}

/** Asks for per-unit Difficulty and Tags overrides until the human picks "done". */
async function collectOverrides(ui: ApproverUI, units: string[]): Promise<Override[] | Cancelled> {
	if (!(await ui.confirm("Adjust Difficulty or Tags?", "Override the Difficulty or Tags of a unit before approving?"))) {
		return [];
	}
	const byUnit = new Map<string, Override>();
	for (;;) {
		const unit = await pick(ui, "Unit to adjust", [...units, DONE]);
		if (unit === CANCELLED) return CANCELLED;
		if (unit === DONE) return [...byUnit.values()];
		const change = await askOverrideField(ui, unit);
		if (change === CANCELLED) return CANCELLED;
		byUnit.set(unit, { ...(byUnit.get(unit) ?? { unit }), ...change });
	}
}

async function askOverrideField(
	ui: ApproverUI,
	unit: string,
): Promise<{ difficulty: Difficulty } | { tags: string[] } | Cancelled> {
	const field = await pick(ui, `Field of ${unit}`, [DIFFICULTY_FIELD, TAGS_FIELD]);
	if (field === CANCELLED) return CANCELLED;
	if (field === DIFFICULTY_FIELD) {
		const value = await pick(ui, `Difficulty of ${unit}`, DIFFICULTIES);
		return value === CANCELLED ? CANCELLED : { difficulty: value as Difficulty };
	}
	const value = await ask(ui, `Tags of ${unit}`, "a, b");
	if (value === CANCELLED) return CANCELLED;
	return { tags: value.split(",").map((tag) => tag.trim()).filter((tag) => tag !== "") };
}

/** Gate and amendment requests: approve, request changes, dismiss, or one of the request's options (e.g. `waive`). */
async function gateFlow(ui: ApproverUI, r: ApprovalRequest): Promise<Verdict | Cancelled> {
	const options = r.options ?? [];
	const selected = await pick(ui, r.summary, [APPROVE, REQUEST_CHANGES, DISMISS, ...options.map((o) => o.label)]);
	if (selected === CANCELLED || selected === DISMISS) return CANCELLED;
	if (selected === REQUEST_CHANGES) {
		const notes = await ask(ui, "Requested changes");
		return notes === CANCELLED || notes === "" ? CANCELLED : { outcome: "changes_requested", notes };
	}
	const notes = await optionalNotes(ui);
	if (notes === CANCELLED) return CANCELLED;
	const outcome: Outcome = notes === "" ? "approved" : "approved_with_notes";
	const verdict: Verdict = { outcome, notes };
	const option = options.find((o) => o.label === selected);
	if (option) verdict.choice = option.id;
	if (r.overridable) {
		const overrides = await collectOverrides(ui, r.overridable.units);
		if (overrides === CANCELLED) return CANCELLED;
		if (overrides.length > 0) verdict.overrides = overrides;
	}
	return verdict;
}

/** Does the answer change a requirement: no, one of the declared requirements, or a typed one. */
async function askChangedRequirement(ui: ApproverUI, requirements: string[]): Promise<string | undefined | Cancelled> {
	const selected = await pick(ui, "Does the answer change a requirement?", [NO_CHANGE, ...requirements, OTHER]);
	if (selected === CANCELLED) return CANCELLED;
	if (selected === NO_CHANGE) return undefined;
	if (selected !== OTHER) return selected;
	const typed = await ask(ui, "Changed requirement", "<capability>/Requirement: <name>");
	return typed === CANCELLED || typed === "" ? CANCELLED : typed;
}

async function questionFlow(ui: ApproverUI, r: ApprovalRequest): Promise<Verdict | Deferred | Cancelled> {
	const when = await pick(ui, r.summary, [ANSWER_NOW, ANSWER_LATER]);
	if (when === CANCELLED) return CANCELLED;
	if (when === ANSWER_LATER) return { status: "deferred", questionClass: "non-blocking" };
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
	const options = r.options ?? [];
	const selected = await pick(ui, r.summary, options.map((o) => o.label));
	if (selected === CANCELLED) return CANCELLED;
	const option = options.find((o) => o.label === selected);
	return option ? { outcome: "approved", notes: "", choice: option.id } : CANCELLED;
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
