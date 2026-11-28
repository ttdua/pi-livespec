// The dialog's UI state and its reducer. Pure: every action returns a new state, nothing is mutated.

import type { Difficulty } from "../approver.ts";
import type { DialogEntry, DialogModel, TabName } from "./model.ts";

export type EditorName = "note" | "answer" | "tags";

export type DialogState = {
	tab: number;
	focus: number;
	scroll: number;
	picked?: number;
	unitsOpen: boolean;
	notes: string;
	answer: string;
	overrides: Readonly<Record<string, { difficulty?: Difficulty; tags?: string[] }>>;
	editor?: EditorName;
	error?: string;
	done?: "submitted" | "cancelled" | "deferred";
};

export type DialogAction =
	| { type: "move"; delta: 1 | -1 }
	| { type: "scroll"; delta: number }
	| { type: "pick"; index?: number }
	| { type: "openUnits" }
	| { type: "nextTab" }
	| { type: "previousTab" }
	| { type: "openEditor"; editor: EditorName }
	| { type: "closeEditor"; text: string }
	| { type: "cycleDifficulty"; delta: 1 | -1 }
	| { type: "submit" }
	| { type: "cancel" };

const LEVELS: Difficulty[] = ["low", "medium", "high"];

export function initialState(_model: DialogModel): DialogState {
	return { tab: 0, focus: 0, scroll: 0, notes: "", answer: "", unitsOpen: false, overrides: {} };
}

/** The tabs now shown: the units tab sits between decision and review once opened. */
export const tabsOf = (model: DialogModel, state: DialogState): TabName[] =>
	state.unitsOpen ? ["decision", "units", "review"] : model.tabs;

const tabOf = (model: DialogModel, state: DialogState) => tabsOf(model, state)[state.tab];

/** The rows the active tab can focus. */
function rowCount(model: DialogModel, state: DialogState): number {
	const tab = tabOf(model, state);
	if (tab === "decision") return model.entries.length;
	if (tab === "units") return model.units.length;
	return 0;
}

export function canSubmit(model: DialogModel, state: DialogState): { ok: true } | { ok: false; reason: string } {
	const entry = state.picked === undefined ? undefined : model.entries[state.picked];
	if (entry === undefined) return { ok: false, reason: "Pick an answer on the Decision tab first" };
	if (entry.action.kind === "changes" && state.notes.trim() === "") return { ok: false, reason: "Requested changes need a note" };
	if (entry.action.kind === "own" && state.answer.trim() === "") return { ok: false, reason: "Type your answer first" };
	return { ok: true };
}

const goTo = (state: DialogState, tab: number): DialogState => ({ ...state, tab, focus: 0, scroll: 0, error: undefined });

function move(model: DialogModel, state: DialogState, delta: 1 | -1): DialogState {
	const rows = rowCount(model, state);
	return rows === 0 ? state : { ...state, focus: (state.focus + delta + rows) % rows };
}

function shiftTab(model: DialogModel, state: DialogState, delta: 1 | -1): DialogState {
	const count = tabsOf(model, state).length;
	return goTo(state, (state.tab + delta + count) % count);
}

function pick(model: DialogModel, state: DialogState, index: number | undefined): DialogState {
	if (tabOf(model, state) !== "decision") return state;
	const i = index ?? state.focus;
	const entry = model.entries[i];
	if (entry === undefined) return state;
	const next: DialogState = { ...state, picked: i, focus: i, error: undefined };
	switch (entry.action.kind) {
		case "dismiss":
			return { ...next, done: "cancelled" };
		case "later":
			return { ...next, done: "deferred" };
		case "changes":
			return state.notes.trim() === "" ? { ...next, editor: "note" } : goTo(next, state.tab + 1);
		case "own":
			return state.answer.trim() === "" ? { ...next, editor: "answer" } : goTo(next, Math.min(state.tab + 1, tabsOf(model, state).length - 1));
		default:
			return goTo(next, Math.min(state.tab + 1, tabsOf(model, state).length - 1));
	}
}

/** Splits `a, b` into trimmed, non-empty tags. */
const parseTags = (text: string): string[] => text.split(",").map((t) => t.trim()).filter((t) => t !== "");

function withOverride(model: DialogModel, state: DialogState, change: { difficulty?: Difficulty; tags?: string[] }): DialogState {
	const unit = model.units[state.focus]?.unit;
	if (unit === undefined) return state;
	return { ...state, overrides: { ...state.overrides, [unit]: { ...state.overrides[unit], ...change } } };
}

function closeEditor(model: DialogModel, state: DialogState, text: string): DialogState {
	if (state.editor === "tags" && tabOf(model, state) !== "units") return state;
	const closed: DialogState = { ...state, editor: undefined, error: undefined };
	switch (state.editor) {
		case "note":
			return { ...closed, notes: text };
		case "answer":
			return { ...closed, answer: text };
		case "tags":
			return withOverride(model, closed, { tags: parseTags(text) });
		default:
			return state;
	}
}

/** An editor can open only where its field is shown: tags on the units tab, notes when the model has them. */
function openEditor(model: DialogModel, state: DialogState, editor: EditorName): DialogState {
	if (editor === "tags" && tabOf(model, state) !== "units") return state;
	if (editor === "note" && !model.notes) return state;
	return { ...state, editor, error: undefined };
}

function cycleDifficulty(model: DialogModel, state: DialogState, delta: 1 | -1): DialogState {
	const unit = model.units[state.focus];
	if (tabOf(model, state) !== "units" || unit === undefined) return state;
	const current = state.overrides[unit.unit]?.difficulty ?? unit.difficulty;
	const index = current === undefined ? (delta === 1 ? 0 : LEVELS.length - 1) : (LEVELS.indexOf(current) + delta + LEVELS.length) % LEVELS.length;
	return withOverride(model, state, { difficulty: LEVELS[index] });
}

function submit(model: DialogModel, state: DialogState): DialogState {
	if (tabOf(model, state) !== "review") return state;
	const check = canSubmit(model, state);
	return check.ok ? { ...state, done: "submitted", error: undefined } : { ...state, error: check.reason };
}

/** Opens the units tab for the rest of the dialog; only from the decision tab and only when the request has units. */
function openUnits(model: DialogModel, state: DialogState): DialogState {
	if (!model.unitsAvailable || tabOf(model, state) !== "decision") return state;
	return goTo({ ...state, unitsOpen: true }, 1);
}

function cancel(state: DialogState): DialogState {
	return state.editor === undefined ? { ...state, done: "cancelled" } : { ...state, editor: undefined };
}

export function reduce(model: DialogModel, state: DialogState, action: DialogAction): DialogState {
	switch (action.type) {
		case "move":
			return move(model, state, action.delta);
		case "scroll":
			return { ...state, scroll: Math.max(0, state.scroll + action.delta) };
		case "pick":
			return pick(model, state, action.index);
		case "openUnits":
			return openUnits(model, state);
		case "nextTab":
			return shiftTab(model, state, 1);
		case "previousTab":
			return shiftTab(model, state, -1);
		case "openEditor":
			return openEditor(model, state, action.editor);
		case "closeEditor":
			return closeEditor(model, state, action.text);
		case "cycleDifficulty":
			return cycleDifficulty(model, state, action.delta);
		case "submit":
			return submit(model, state);
		case "cancel":
			return cancel(state);
	}
}
