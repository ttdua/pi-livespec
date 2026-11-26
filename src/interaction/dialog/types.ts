// Types the in-session dialog shares with `ApproverUI`: the `ctx.ui.custom` factory and what it resolves.

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { Deferred } from "../approver.ts";
import type { Verdict } from "../flow-result.ts";

/** A `ctx.ui.custom` factory; `done` closes the dialog with `result`. */
export type DialogFactory<T> = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component;

/** What the dialog resolves: an answer, or an explicit cancel (distinct from `custom()` resolving `undefined`). */
export type DialogOutcome = { kind: "result"; result: Verdict | Deferred } | { kind: "cancelled" };
