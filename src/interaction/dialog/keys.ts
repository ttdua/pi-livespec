// Maps raw terminal input to dialog actions. Pure: reads the model and state, never changes them.
// Configurable actions go through the injected `KeybindingsManager`; the dialog's own keys
// (digits, `n`, `e`, Tab, arrows) through `matchesKey`/`decodeKittyPrintable`, so the Kitty protocol works.

import { decodeKittyPrintable, type KeybindingsManager, matchesKey } from "@earendil-works/pi-tui";
import type { DialogModel, TabName } from "./model.ts";
import { type DialogAction, type DialogState, tabsOf } from "./state.ts";

/** Lines one PageUp/PageDown scrolls the facts and briefing. */
export const SCROLL_PAGE_LINES = 5;

/** The printable character `data` stands for, raw or Kitty CSI-u encoded. */
const printableOf = (data: string): string | undefined => (data.length === 1 && data >= " " ? data : decodeKittyPrintable(data));

/** `1`–`9` as a zero-based index. */
function digitIndex(char: string | undefined): number | undefined {
	return char !== undefined && char >= "1" && char <= "9" ? Number(char) - 1 : undefined;
}

/** With an editor open, only submit and cancel are the dialog's; every other key belongs to the field. */
function editorKey(data: string, kb: KeybindingsManager, field: { value(): string }): DialogAction | undefined {
	if (kb.matches(data, "tui.input.submit")) return { type: "closeEditor", text: field.value() };
	if (kb.matches(data, "tui.select.cancel")) return { type: "cancel" };
	return undefined;
}

/** Keys that mean the same on every tab. */
function commonKey(data: string, kb: KeybindingsManager): DialogAction | undefined {
	if (kb.matches(data, "tui.select.cancel")) return { type: "cancel" };
	if (kb.matches(data, "tui.select.up")) return { type: "move", delta: -1 };
	if (kb.matches(data, "tui.select.down")) return { type: "move", delta: 1 };
	if (kb.matches(data, "tui.select.pageUp")) return { type: "scroll", delta: -SCROLL_PAGE_LINES };
	if (kb.matches(data, "tui.select.pageDown")) return { type: "scroll", delta: SCROLL_PAGE_LINES };
	if (matchesKey(data, "shift+tab")) return { type: "previousTab" };
	if (matchesKey(data, "tab")) return { type: "nextTab" };
	return undefined;
}

function decisionKey(data: string, kb: KeybindingsManager, model: DialogModel, state: DialogState): DialogAction | undefined {
	if (kb.matches(data, "tui.select.confirm")) return { type: "pick" };
	const char = printableOf(data);
	const index = digitIndex(char);
	if (index !== undefined) return index < model.entries.length ? { type: "pick", index } : undefined;
	if (char === "u" && model.unitsAvailable && !state.unitsOpen) return { type: "openUnits" };
	return char === "n" && model.notes ? { type: "openEditor", editor: "note" } : undefined;
}

function unitsKey(data: string, kb: KeybindingsManager): DialogAction | undefined {
	if (kb.matches(data, "tui.select.confirm")) return { type: "nextTab" };
	if (matchesKey(data, "right")) return { type: "cycleDifficulty", delta: 1 };
	if (matchesKey(data, "left")) return { type: "cycleDifficulty", delta: -1 };
	return printableOf(data) === "e" ? { type: "openEditor", editor: "tags" } : undefined;
}

function reviewKey(data: string, kb: KeybindingsManager, model: DialogModel): DialogAction | undefined {
	if (kb.matches(data, "tui.select.confirm")) return { type: "submit" };
	return printableOf(data) === "n" && model.notes ? { type: "openEditor", editor: "note" } : undefined;
}

const TAB_KEYS: Record<TabName, (data: string, kb: KeybindingsManager, model: DialogModel, state: DialogState) => DialogAction | undefined> = {
	decision: decisionKey,
	units: unitsKey,
	review: reviewKey,
};

/** The action `data` stands for, or `undefined` (with an editor open: forward the key to the field). */
export function keyToAction(
	data: string,
	kb: KeybindingsManager,
	model: DialogModel,
	state: DialogState,
	field: { value(): string },
): DialogAction | undefined {
	if (state.editor !== undefined) return editorKey(data, kb, field);
	const tab = tabsOf(model, state)[state.tab];
	return commonKey(data, kb) ?? (tab === undefined ? undefined : TAB_KEYS[tab](data, kb, model, state));
}
