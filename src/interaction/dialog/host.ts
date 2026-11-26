// The pi `Component` behind the in-session dialog: keys → reducer → view, and `done` once.
// The open `TextField` owns the text being typed; the reducer only sees it on submit, so every
// key but submit and cancel goes to the field while an editor is open.

import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Editor, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { ApprovalRequest } from "../approver.ts";
import { CANCELLED } from "../flow-result.ts";
import { keyToAction } from "./keys.ts";
import { buildModel, type DialogModel, toResult } from "./model.ts";
import { type DialogState, type EditorName, initialState, reduce } from "./state.ts";
import type { DialogFactory, DialogOutcome } from "./types.ts";
import { type DialogTheme, renderDialog } from "./view.ts";

/** The text editor the dialog opens; it owns the typed text until the dialog reads `value()` on submit. */
export type TextField = { value(): string; set(text: string): void; handleInput(data: string): void; render(width: number): string[]; focused: boolean };

/** Rows left to pi's own chrome around the dialog. */
const RESERVED_ROWS = 4;
const MIN_HEIGHT = 10;

/** The default field: pi-tui's `Editor`; `value()` expands paste markers. */
function editorField(tui: TUI, theme: Theme): TextField {
	const editor = new Editor(tui, { borderColor: (s) => theme.fg("border", s), selectList: getSelectListTheme() });
	return {
		value: () => editor.getExpandedText(),
		set: (text) => editor.setText(text),
		handleInput: (data) => editor.handleInput(data),
		render: (width) => editor.render(width),
		get focused() {
			return editor.focused;
		},
		set focused(on: boolean) {
			editor.focused = on;
		},
	};
}

const dialogThemeOf = (theme: Theme): DialogTheme => ({
	accent: (s) => theme.fg("accent", s),
	muted: (s) => theme.fg("muted", s),
	bold: (s) => theme.bold(s),
});

/** The text an editor starts with: what the state already holds for its field. */
function prefillOf(model: DialogModel, state: DialogState, editor: EditorName): string {
	if (editor === "note") return state.notes;
	if (editor === "answer") return state.answer;
	if (editor === "requirement") return state.requirement?.kind === "other" ? state.requirement.text : "";
	const unit = model.units[state.focus];
	return unit === undefined ? "" : (state.overrides[unit.unit]?.tags ?? unit.tags).join(", ");
}

/** What a finished state resolves; `undefined` while the dialog is still open. */
function outcomeOf(model: DialogModel, state: DialogState, r: ApprovalRequest): DialogOutcome | undefined {
	if (state.done === undefined) return undefined;
	if (state.done === "cancelled") return { kind: "cancelled" };
	const result = toResult(model, state, r);
	return result === CANCELLED ? { kind: "cancelled" } : { kind: "result", result };
}

class DialogHost implements Component, Focusable {
	private state: DialogState;
	private field: TextField | undefined;
	private finished = false;
	private hasFocus = false;
	private readonly theme: DialogTheme;

	constructor(
		private readonly r: ApprovalRequest,
		private readonly model: DialogModel,
		private readonly tui: TUI,
		private readonly piTheme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (result: DialogOutcome) => void,
		private readonly makeField: (tui: TUI, theme: Theme) => TextField,
	) {
		this.state = initialState(model);
		this.theme = dialogThemeOf(piTheme);
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(on: boolean) {
		this.hasFocus = on;
		this.syncFieldFocus();
	}

	handleInput(data: string): void {
		if (this.finished) return;
		const field = this.fieldOf();
		const action = keyToAction(data, this.keybindings, this.model, this.state, field);
		if (action === undefined) {
			if (this.state.editor !== undefined) field.handleInput(data);
		} else {
			this.apply(reduce(this.model, this.state, action));
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const height = Math.max(MIN_HEIGHT, this.tui.terminal.rows - RESERVED_ROWS);
		const editorLines = this.state.editor === undefined ? undefined : this.fieldOf().render(width);
		return renderDialog(this.model, this.state, { width, height }, this.theme, editorLines);
	}

	invalidate(): void {}

	/** Moves to `next`: prefills an editor that just opened, and resolves `done` once the dialog finished. */
	private apply(next: DialogState): void {
		const opened = next.editor !== undefined && next.editor !== this.state.editor;
		this.state = next;
		if (opened && next.editor !== undefined) this.fieldOf().set(prefillOf(this.model, next, next.editor));
		this.syncFieldFocus();
		const outcome = outcomeOf(this.model, next, this.r);
		if (outcome === undefined) return;
		this.finished = true;
		this.done(outcome);
	}

	/** The open field draws its cursor only while the dialog has focus. */
	private syncFieldFocus(): void {
		if (this.field !== undefined) this.field.focused = this.hasFocus && this.state.editor !== undefined;
	}

	/** One field for the dialog's lifetime, created on first use. */
	private fieldOf(): TextField {
		this.field ??= this.makeField(this.tui, this.piTheme);
		return this.field;
	}
}

/** The `ctx.ui.custom` factory for `r`; `makeField` replaces the `Editor` (tests). */
export function createDialog(r: ApprovalRequest, makeField: (tui: TUI, theme: Theme) => TextField = editorField): DialogFactory<DialogOutcome> {
	const model = buildModel(r);
	return (tui, theme, keybindings, done) => new DialogHost(r, model, tui, theme, keybindings, done, makeField);
}
