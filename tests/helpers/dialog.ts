// Headless driver for the in-session dialog: a stub keybindings table, an identity theme, a fake
// text field and a fake `tui`, so a test can feed keys to `createDialog` and read what it resolves.

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import type { TextField } from "../../src/interaction/dialog/host.ts";
import type { DialogFactory, DialogOutcome } from "../../src/interaction/dialog/types.ts";

export const KEY = { enter: "\r", escape: "\x1b", tab: "\t", down: "\x1b[B", right: "\x1b[C", backspace: "\x7f", newLine: "\x1b[13;2u" };

/** Keybinding id → the raw inputs that match it; tests may add entries (e.g. page keys) and remove them after. */
export const KEY_TABLE: Record<string, string[]> = {
	"tui.select.up": ["\x1b[A"],
	"tui.select.down": [KEY.down],
	"tui.select.confirm": [KEY.enter],
	"tui.select.cancel": [KEY.escape, "\x03"],
	"tui.input.submit": [KEY.enter],
};
export const stubKeybindings = { matches: (data: string, id: string) => KEY_TABLE[id]?.includes(data) ?? false } as unknown as KeybindingsManager;
export const identityTheme = { fg: (_color: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

/** A field that types printable keys, deletes on Backspace and records every key it receives. */
export class FakeField implements TextField {
	text = "";
	focused = false;
	received: string[] = [];
	sets: string[] = [];
	invalidated = 0;
	value(): string {
		return this.text;
	}
	set(text: string): void {
		this.text = text;
		this.sets.push(text);
	}
	handleInput(data: string): void {
		this.received.push(data);
		if (data === KEY.backspace) this.text = this.text.slice(0, -1);
		else if (data === KEY.newLine) this.text += "\n";
		else this.text += data;
	}
	render(): string[] {
		return [`[${this.text}]`];
	}
	invalidate(): void {
		this.invalidated += 1;
	}
}

export const fakeTui = (rows = 30): TUI => ({ requestRender: vi.fn(), terminal: { rows } }) as unknown as TUI;

/** `text` as one key per character, as a terminal delivers typing. */
export const typed = (text: string): string[] => [...text];

/**
 * An `ApproverUI.dialog` that mounts the factory headless, presses `keys` in order and resolves what
 * the dialog passed to `done`; `undefined` when the keys did not finish it. `opened` counts mounts.
 */
export function scriptedDialog(keys: string[]): ((factory: DialogFactory<DialogOutcome>) => Promise<DialogOutcome | undefined>) & { opened: number } {
	const run = async (factory: DialogFactory<DialogOutcome>): Promise<DialogOutcome | undefined> => {
		run.opened += 1;
		let outcome: DialogOutcome | undefined;
		const component = factory(fakeTui(), identityTheme, stubKeybindings, (o) => {
			outcome = o;
		});
		for (const key of keys) component.handleInput?.(key);
		return outcome;
	};
	run.opened = 0;
	return run;
}
