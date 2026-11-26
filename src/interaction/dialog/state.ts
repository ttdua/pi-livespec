// The dialog's UI state and its reducer. Pure: every action returns a new state, nothing is mutated.

import type { Difficulty } from "../approver.ts";
import type { DialogEntry, DialogModel } from "./model.ts";

export type EditorName = "note" | "answer" | "tags" | "requirement";
export type Requirement = { kind: "none" } | { kind: "named"; name: string } | { kind: "other"; text: string };

export type DialogState = {
	tab: number;
	focus: number;
	scroll: number;
	picked?: number;
	notes: string;
	answer: string;
	overrides: Readonly<Record<string, { difficulty?: Difficulty; tags?: string[] }>>;
	requirement?: Requirement;
	editor?: EditorName;
	error?: string;
	done?: "submitted" | "cancelled" | "deferred";
};

export type DialogAction =
	| { type: "move"; delta: 1 | -1 }
	| { type: "scroll"; delta: number }
	| { type: "pick"; index?: number }
	| { type: "nextTab" }
	| { type: "previousTab" }
	| { type: "openEditor"; editor: EditorName }
	| { type: "closeEditor"; text: string }
	| { type: "cycleDifficulty"; delta: 1 | -1 }
	| { type: "pickRequirement"; index: number }
	| { type: "submit" }
	| { type: "cancel" };

const LEVELS: Difficulty[] = ["low", "medium", "high"];

export function initialState(_model: DialogModel): DialogState {
	return { tab: 0, focus: 0, scroll: 0, notes: "", answer: "", overrides: {} };
}

const tabOf = (model: DialogModel, state: DialogState) => model.tabs[state.tab];

/** The rows the active tab can focus. */
function rowCount(model: DialogModel, state: DialogState): number {
	const tab = tabOf(model, state);
	if (tab === "decision") return model.entries.length;
	if (tab === "units") return model.units.length;
	return model.kind === "question" ? model.requirements.length + 2 : 0;
}

/** The picked entry's action is a question answer (candidate or own). */
function isAnswer(entry: DialogEntry | undefined): boolean {
	return entry?.action.kind === "candidate" || entry?.action.kind === "own";
}

export function canSubmit(model: DialogModel, state: DialogState): { ok: true } | { ok: false; reason: string } {
	const entry = state.picked === undefined ? undefined : model.entries[state.picked];
	if (entry === undefined) return { ok: false, reason: "Pick an answer on the Decision tab first" };
	if (entry.action.kind === "changes" && state.notes.trim() === "") return { ok: false, reason: "Requested changes need a note" };
	if (entry.action.kind === "own" && state.answer.trim() === "") return { ok: false, reason: "Type your answer first" };
	if (!isAnswer(entry)) return { ok: true };
	const changed = state.requirement;
	if (changed === undefined) return { ok: false, reason: "Say whether the answer changes a requirement" };
	if (changed.kind === "other" && changed.text.trim() === "") return { ok: false, reason: "Type the changed requirement first" };
	return { ok: true };
}

const goTo = (state: DialogState, tab: number): DialogState => ({ ...state, tab, focus: 0, scroll: 0, error: undefined });

function move(model: DialogModel, state: DialogState, delta: 1 | -1): DialogState {
	const rows = rowCount(model, state);
	return rows === 0 ? state : { ...state, focus: (state.focus + delta + rows) % rows };
}

function shiftTab(model: DialogModel, state: DialogState, delta: 1 | -1): DialogState {
	return goTo(state, (state.tab + delta + model.tabs.length) % model.tabs.length);
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
			return { ...next, editor: "answer" };
		default:
			return goTo(next, Math.min(state.tab + 1, model.tabs.length - 1));
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
	const closed: DialogState = { ...state, editor: undefined, error: undefined };
	switch (state.editor) {
		case "note":
			return { ...closed, notes: text };
		case "answer":
			return { ...closed, answer: text };
		case "requirement":
			return { ...closed, requirement: { kind: "other", text } };
		case "tags":
			return withOverride(model, closed, { tags: parseTags(text) });
		default:
			return state;
	}
}

function cycleDifficulty(model: DialogModel, state: DialogState, delta: 1 | -1): DialogState {
	const unit = model.units[state.focus];
	if (tabOf(model, state) !== "units" || unit === undefined) return state;
	const current = state.overrides[unit.unit]?.difficulty ?? unit.difficulty;
	const index = current === undefined ? (delta === 1 ? 0 : LEVELS.length - 1) : (LEVELS.indexOf(current) + delta + LEVELS.length) % LEVELS.length;
	return withOverride(model, state, { difficulty: LEVELS[index] });
}

function pickRequirement(model: DialogModel, state: DialogState, index: number): DialogState {
	if (model.kind !== "question" || index < 0 || index > model.requirements.length + 1) return state;
	if (index === 0) return { ...state, requirement: { kind: "none" }, error: undefined };
	const name = model.requirements[index - 1];
	if (name !== undefined) return { ...state, requirement: { kind: "named", name }, error: undefined };
	const text = state.requirement?.kind === "other" ? state.requirement.text : "";
	return { ...state, requirement: { kind: "other", text }, editor: "requirement", error: undefined };
}

function submit(model: DialogModel, state: DialogState): DialogState {
	if (tabOf(model, state) !== "review") return state;
	const check = canSubmit(model, state);
	return check.ok ? { ...state, done: "submitted", error: undefined } : { ...state, error: check.reason };
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
		case "nextTab":
			return shiftTab(model, state, 1);
		case "previousTab":
			return shiftTab(model, state, -1);
		case "openEditor":
			return { ...state, editor: action.editor };
		case "closeEditor":
			return closeEditor(model, state, action.text);
		case "cycleDifficulty":
			return cycleDifficulty(model, state, action.delta);
		case "pickRequirement":
			return pickRequirement(model, state, action.index);
		case "submit":
			return submit(model, state);
		case "cancel":
			return cancel(state);
	}
}
