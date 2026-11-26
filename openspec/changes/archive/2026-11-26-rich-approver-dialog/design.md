## Context

The in-session adapter (`src/interaction/in-session.ts`) receives an `ApprovalRequest` and runs one of three flows: `gateFlow` (gates, amendments, proposers), `questionFlow` and `choiceFlow` (stuck reports and `decide:` rule asks). Each flow is a chain of `ApproverUI.select`/`input` calls; `menu.ts` builds the entries and the title. `ApproverUI` is built in `src/tools/approver-for.ts` from the tool `ctx` (`ApproverCtx = { hasUI, ui }`); every request-producing tool passes its `ctx` through `dispatchRequest`/`sendRequest` (`src/tools/request-flow.ts`). Choice data comes from `gateChoices(r)` (`describe-actions.ts`) and `r.options`; the briefing from `r.briefing`. A flow returns a `Verdict`, a `Deferred` (answer later) or `CANCELLED` (→ `dismissed`).

pi exposes `ctx.ui.custom<T>(factory, options)`: the factory receives `(tui, theme, keybindings, done)` and returns a `Component` (`render(width): string[]`, `handleInput(data)`, `invalidate()`); `done(value)` closes it. It renders only in the TUI: in RPC mode `hasUI` is true but `custom()` resolves `undefined` (`docs/rpc-extension-ui.md`), and `ctx.mode` is `"tui" | "rpc" | "json" | "print"`. Keys come through the injected `KeybindingsManager` (`tui.select.up/down/confirm/cancel`, `tui.input.submit/newLine`). Width helpers (`visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`) and the `Editor` component live in `@earendil-works/pi-tui`, which `pi-coding-agent` does not re-export.

## Goals / Non-Goals

**Goals:**
- One `ctx.ui.custom()` dialog per in-session request, with the tabs, notes, review step and keys agreed in `brainstorm.md`.
- The same `Verdict`/`Deferred`/cancel results as the `select`/`input` flows, so `in-session.ts` callers, answer records and completion are untouched.
- A clean fallback to the existing chain wherever the dialog cannot be drawn.
- Dialog logic testable headless: state and key handling as pure functions, rendering as a pure function of state and width.

**Non-Goals:**
- Mouse support, collapse key, external editor (`Ctrl+G`), localisation, terminal BEL: rpiv features not needed for a decision dialog.
- Changing the forge adapter, the account picker (`src/accounts/resolve.ts`) or any tool parameter.
- Theming beyond the injected `theme` colours.

## Decisions

### D1. Module split: model, keys, view, host
Four units under `src/interaction/dialog/`:
- `model.ts`: builds a `DialogModel` from an `ApprovalRequest` (tabs, sections, choices with values, which choices need a note or typed text) and turns a submitted `DialogState` into the flow result (`Verdict | Deferred`). Pure; reuses `gateChoices`, `menuEntries` ordering and `neutralise`.
- `state.ts`: the `DialogState` (active tab, focused row, scroll offset, picked choice, notes, typed answer, unit overrides, requirement change, open editor) and `reduce(model, state, action)`: a pure reducer over named actions (`move`, `scroll`, `pick`, `nextTab`, `openEditor`, `closeEditor(text)`, `cycleDifficulty`, `pickRequirement`, `submit`, `cancel`, …). Validation lives in a separate pure `canSubmit(model, state)` (a `changes` pick needs a note; typed answer and typed requirement non-empty).
- `keys.ts`: maps raw input to actions through the injected `KeybindingsManager` (`tui.select.*`, `tui.input.submit`) plus the dialog's own keys (`1`–`9`, `n`, `Tab`/`Shift+Tab`, `←`/`→` on unit rows, `e` for tags, `PageUp`/`PageDown`), matched with pi-tui `matchesKey`/`decodeKittyPrintable` so the Kitty keyboard protocol works. While a text editor is open, `keys.ts` returns an action only for submit (`closeEditor` with the field's text) and cancel; every other key is forwarded by the host to the text field.
- `view.ts`: `render(model, state, width, theme): string[]`, pure, using `visibleWidth`/`truncateToWidth`/`wrapTextWithAnsi`.
- `host.ts`: the `Component` that owns the state, calls `keys` → `reduce`, re-renders, and calls `done` with the final result. Text entry uses pi-tui's `Editor` behind a `TextField` interface: the editor is the single owner of the text being typed (cursor, deletion, paste, new lines); the reducer only receives the committed text on submit (`getExpandedText()`, so paste markers are expanded), and Enter never reaches the `Editor`. The `Editor` is built with `getSelectListTheme()` from pi-coding-agent and `borderColor: (s) => theme.fg("border", s)`; it reads pi's global keybindings, which match the injected manager. The host reads the height from `tui.terminal.rows`.
Why: the agreed TUI architecture keeps input → action → state → render separate; reducer and view are unit-testable without a terminal. Alternative: one class like the current flows (rejected: a god component holding UI state, validation and rendering).

### D2. Flow selection and fallback detection
`ApproverUI` gains an optional `dialog?: <T>(factory: DialogFactory<T>) => Promise<T | undefined>` (a narrowed `ctx.ui.custom`; the UI types are imported with `import type` from `dialog/`). `ApproverCtx` gains `mode?: ExtensionMode` and `ui.custom?` with the same signature. `approver-for.ts` sets `dialog` only when `ctx.mode === "tui"` and `ctx.ui.custom` is a function. `createInSessionApprover` uses the dialog when `ui.dialog` is present; otherwise the current flows run unchanged. If the dialog resolves `undefined` without the human having acted (a host that accepted the call but drew nothing), the adapter falls back to the `select`/`input` flow for the same request, so an older or partial host never turns into a silent `dismissed`. The host component resolves `done` with an explicit `{ kind: "cancelled" }` on Esc, distinct from `undefined`.
Why: `ctx.mode` is the documented guard; the `undefined` backstop covers hosts that report `tui` but cannot render (the same backstop rpiv uses). Alternative: probe with a throwaway `custom()` call (rejected: flashes UI and costs a round trip).

### D3. One result type for both paths
The dialog returns the same `Verdict | Deferred | Cancelled` the flows return (`Verdict`, `CANCELLED` and `Cancelled` move to `src/interaction/flow-result.ts`, so `in-session.ts`, the flows and `dialog/` share them without an import cycle; `Deferred` stays in `approver.ts`). Entry labels and the briefing heading/lines come from `menu.ts` exports shared by both paths, so the labels cannot drift; `createInSessionApprover` keeps building `Answered` (`by`, `at`, `adapter: "in-session"`) in one place. The record format, `overrides`, `choice`, `answer`, `changesRequirement` and `questionClass` are produced by `model.ts` from the state with the same rules as `gateFlow`/`questionFlow`/`choiceFlow` (empty notes → `approved`, notes → `approved_with_notes`, `changes` → `changes_requested` with non-empty notes, a picked candidate's label is the answer).
Why: one answer contract regardless of the UI path. Equivalence is tested by driving both paths with the same request and choices and comparing results.

### D3a. Current unit values on the request
The Adjust units tab shows each unit's current Difficulty and Tags and records only changed fields, so the request must carry them. `ApprovalRequest.overridable` becomes `{ units: string[]; current?: Record<string, { difficulty?: Difficulty; tags: string[] }> }`. `spec_gate plan` fills `current` from `state.change.units`, narrowing `Unit.difficulty` (a `string`) to `Difficulty` with a guard like the existing `isLevel` and leaving it out when it is not a level; `unit_amend` from the classified unit it already builds (`AmendPlan` gains the classified unit's values). `overridable` is not part of the stored request yaml, so the forge format and stored-request reads are untouched. The `select` fallback keeps recording whatever the human sets, which is the same answer for every value the human changed (the spec's equivalence rule).
Why: the summary text holds the values only as prose; parsing it back would be fragile. Alternative: change `units` to objects (rejected: touches every consumer of `overridable.units` for no gain).

The model also carries the check status rows of a gate (`!` for each failing waivable check, from `failingWaivableOf(r.record.snapshot)`), so the view can show status with a symbol. A unit with no current Difficulty shows `—`, and the first cycle step sets `low`.

### D4. Tabs per request kind
- Gate-like (gates, amendments, proposers): Decision, Adjust units (only when `r.overridable`), Review.
- Question: Decision (candidates, "Write my own answer", "Answer later"), Review (shows the answer and asks "Does the answer change a requirement?" with `no`, each declared requirement, and `other` with typed text). "Answer later" submits a `Deferred` straight from Decision: nothing is recorded, so no review is needed.
- Stuck and `decide:` asks: Decision, Review. No notes: their in-session verdict has none today; a note stays available on the forge through `/livespec choose <id> [notes]` (an intended scope limit, not a regression).
- Dismiss on a gate is an entry, as today; picking it ends the dialog as cancelled (`dismissed`) without Review.
- Overrides with request changes: the Review tab lists them as discarded and `toResult` drops them, matching the fallback, which never collects overrides on `changes_requested`.
- Empty required text (request-changes note, typed answer, typed requirement) blocks submit in the dialog; the fallback keeps treating it as `dismissed`. Equivalence is defined over submitted answers only.
Every other answer passes Review; `Enter` on a Decision entry moves to the next tab, `Enter` on Review submits.

### D5. Layout and widths
Order on Decision: facts (`r.summary`), a blank line, the briefing block (author heading, summary, watch list, recommended label, rationale), a blank line, the entries (`<n> <label>` with the recommended mark, description on the next line, indented), then a footer with the note line and key hints. The body above the entries scrolls when it does not fit (`PageUp`/`PageDown` only, clamped by the host to the last page via `maxScrollOf`; the arrow keys move between entries and wrap); the entries and footer stay visible. Full layout from 60 columns; from 40 to 59 descriptions and the key-hint line are dropped; below 40 one line: `Too narrow — widen or press Esc`. With an editor open the editor and error stay whole and the entries shrink to the focused row plus a `… N more` line. Height: the dialog renders at most the terminal rows minus 4 and scrolls inside that.
Why: the brainstorm agreed on these thresholds; the entries must never scroll out of view because they are the decision.

### D6. Text safety and identity
Agent text (`summary`, briefing fields, option labels and descriptions, candidate labels) is passed through `neutralise` before it reaches `view.ts`; terminal sequences are removed whole with pi-tui `stripTerminalSequences`, then remaining C0/C1 control characters other than newline and tab are stripped, tabs are expanded to spaces for width math, and bidi override characters are removed too (beyond the spec's minimum, so a label cannot visually reorder the line), so agent text cannot move the cursor or inject escape sequences into the terminal. Choices are carried as `{ value }` in the model; the view never maps text back to identity. Theme colours are applied by the view only to livespec's own chrome (headings, focus marker, status symbols), never derived from agent text. Status is never colour-only: `✓`, `!`, `✗` and `›` carry the meaning.

### D7. Peer dependency
`@earendil-works/pi-tui` is added to `peerDependencies` as `"*"` (user-approved) and, for type-checking and tests, to `devDependencies` as `^1.5.2`, the same range style as `pi-coding-agent`, so one pi-tui copy is installed. Imports from pi-tui: `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `stripTerminalSequences`, `matchesKey`, `decodeKittyPrintable`, `Editor`, and the `Component`/`Focusable`/`TUI`/`KeybindingsManager` types. From pi-coding-agent: `getSelectListTheme`, and the `Theme` and `ExtensionMode` types.

## Risks / Trade-offs

- [The `Editor` component's behaviour inside a custom component differs across pi versions] → wrap it behind a small text-field interface in `host.ts`; tests drive the field through that interface, and a manual TUI check is listed in verify.
- [A host reports `mode: "tui"` but `custom()` never resolves] → not detectable without a timeout; accepted (the same as any blocked dialog today); `Esc` still resolves it.
- [Two UI paths drift apart] → D3's equivalence tests run every request kind through both paths.
- [Terminal escape injection through agent text] → D6 strips control characters before rendering; a test feeds `\x1b[2J` and OSC sequences through every agent field.
- [Larger code surface in `src/interaction/`] → the split in D1 keeps each unit small and pure where possible; the old flows are kept unchanged as the fallback, not rewritten.

## Migration Plan

No data migration. The dialog is used automatically in the pi TUI; RPC, print and JSON modes keep the `select`/`input` chain. Rollback is reverting the change; answer records written by either path are identical.

## Open Questions

- (none: the width thresholds and fallback detection from `brainstorm.md` are settled in D2 and D5.)
