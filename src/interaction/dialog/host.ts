// The pi `Component` behind the in-session dialog: keys → reducer → view, and `done` once.
// The open `TextField` owns the text being typed; the reducer only sees it on submit, so every
// key but submit and cancel goes to the field while an editor is open.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Editor, type Focusable, type KeybindingsManager, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import type { ApprovalRequest } from "../approver.ts";
import { CANCELLED } from "../flow-result.ts";
import { keyToAction } from "./keys.ts";
import { buildModel, type DialogModel, toResult } from "./model.ts";
import { type DialogAction, type DialogState, type EditorName, initialState, reduce } from "./state.ts";
import type { DialogFactory, DialogOutcome } from "./types.ts";
import { type DialogTheme, maxScrollOf, renderDialog } from "./view.ts";

/** The text editor the dialog opens; it owns the typed text until the dialog reads `value()` on submit. */
export type TextField = { value(): string; set(text: string): void; handleInput(data: string): void; render(width: number): string[]; invalidate?(): void; focused: boolean };

/** Rows left to pi's own chrome around the dialog. */
const RESERVED_ROWS = 4;
const MIN_HEIGHT = 10;

/** pi's select-list colours, built from the injected theme so the dialog needs no runtime import from pi-coding-agent. */
function selectListTheme(theme: Theme): SelectListTheme {
	const accent = (s: string) => theme.fg("accent", s);
	const muted = (s: string) => theme.fg("muted", s);
	return { selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: muted };
}

/** The default field: pi-tui's `Editor`; `value()` expands paste markers. */
function editorField(tui: TUI, theme: Theme): TextField {
	const editor = new Editor(tui, { borderColor: (s) => theme.fg("border", s), selectList: selectListTheme(theme) });
	return {
		value: () => editor.getExpandedText(),
		set: (text) => editor.setText(text),
		handleInput: (data) => editor.handleInput(data),
		render: (width) => editor.render(width),
		invalidate: () => editor.invalidate(),
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
	const unit = model.units[state.focus];
	return unit === undefined ? "" : (state.overrides[unit.unit]?.tags ?? unit.tags).join(", ");
}

/** What a finished state resolves; `undefined` while the dialog is still open. */
function outcomeOf(model: DialogModel, state: DialogState): DialogOutcome | undefined {
	if (state.done === undefined) return undefined;
	if (state.done === "cancelled") return { kind: "cancelled" };
	const result = toResult(model, state);
	return result === CANCELLED ? { kind: "cancelled" } : { kind: "result", result };
}

class DialogHost implements Component, Focusable {
	private state: DialogState;
	private field: TextField | undefined;
	private finished = false;
	private hasFocus = false;
	/** The width of the last render: scroll limits depend on it. */
	private width = 80;
	private readonly theme: DialogTheme;

	constructor(
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
		const action = keyToAction(data, this.keybindings, this.model, this.state, { value: () => this.fieldOf().value() });
		if (action === undefined) {
			if (this.state.editor !== undefined) this.fieldOf().handleInput(data);
		} else {
			this.apply(this.clamped(reduce(this.model, this.state, action), action));
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		this.width = width;
		const height = this.height();
		const editorLines = this.state.editor === undefined ? undefined : this.fieldOf().render(width);
		return renderDialog(this.model, this.state, { width, height }, this.theme, editorLines);
	}

	invalidate(): void {
		this.field?.invalidate?.();
	}

	private height(): number {
		return Math.max(MIN_HEIGHT, this.tui.terminal.rows - RESERVED_ROWS);
	}

	/** After a scroll the offset is cut to what the view can show, so one PgUp always moves the body. */
	private clamped(next: DialogState, action: DialogAction): DialogState {
		if (action.type !== "scroll") return next;
		const max = maxScrollOf(this.model, next, { width: this.width, height: this.height() });
		// Clamp the previous offset first: after a widen it may sit above the new max.
		const from = Math.min(this.state.scroll, max);
		return { ...next, scroll: Math.max(0, Math.min(from + action.delta, max)) };
	}

	/** Moves to `next`: prefills an editor that just opened, and resolves `done` once the dialog finished. */
	private apply(next: DialogState): void {
		const opened = next.editor !== undefined && next.editor !== this.state.editor;
		this.state = next;
		if (opened && next.editor !== undefined) this.fieldOf().set(prefillOf(this.model, next, next.editor));
		this.syncFieldFocus();
		const outcome = outcomeOf(this.model, next);
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
	return (tui, theme, keybindings, done) => new DialogHost(model, tui, theme, keybindings, done, makeField);
}
