# Rich Approver Dialog Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** In the pi TUI, every in-session request is answered in one `ctx.ui.custom()` dialog (Decision, Adjust units, Review tabs, notes inside) with the same answers as the existing `select`/`input` chain, which stays as the fallback.

**Architecture:** A pure model (`dialog/model.ts`) turns an `ApprovalRequest` into tabs and entries and a submitted state into the flow result; a pure reducer (`dialog/state.ts`) holds UI state and validation; `dialog/keys.ts` maps input to actions; `dialog/view.ts` renders state to lines; `dialog/host.ts` is the pi `Component` gluing them. `in-session.ts` picks the dialog when `ApproverUI.dialog` is present, else runs today's flows.

**Tech Stack:** TypeScript (ESM, `.ts` imports), vitest, bun; pi `ExtensionAPI` (`ctx.ui.custom`, `ctx.mode`), `@earendil-works/pi-tui` (`visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `Editor`, `Component`, `KeybindingsManager`).

## Global Constraints

- Answers come only from the human; no tool parameter changes (`tests/tools/no-answer-params.test.ts` keeps passing).
- The forge adapter, its comment format, `parseCommand` and answer records do not change.
- The existing flows in `in-session.ts` stay as the fallback; do not rewrite them beyond extracting what the model reuses.
- The only new dependency is `@earendil-works/pi-tui` (peer `"*"`, dev `^1.5.2`), user-approved. No rpiv package.
- Livespec-written text and code comments in English. Run `bun run typecheck` and `bun run test` before each commit.
- Rendering and reducer code are pure and run headless in tests; no real terminal is needed.

## Review Focus

- Equivalence of the two paths: every request kind answered with the same choices gives identical `Answered` fields → `in-session.test.ts` "dialog and select chain agree".
- A `changes` pick with whitespace-only notes is not submittable (trim before the check) → `state.test.ts` "blank note blocks submit".
- Esc inside the editor never cancels the request → `state.test.ts` "Esc in the note editor".
- `custom()` resolving `undefined` after the human already acted must not fall back (the host resolves an explicit marker for cancel) → `in-session.test.ts` "explicit cancel is not a fallback".
- Agent text with CSI/OSC sequences, `\r`, or bidi control characters → `model.test.ts` "strips control characters", `view.test.ts` "no escape sequences in output".
- Wide characters at the column limit: no line exceeds `width` → `view.test.ts` "lines never exceed width" with CJK and emoji.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `package.json` dependencies | modified | `peerDependencies["@earendil-works/pi-tui"] = "*"`; `devDependencies["@earendil-works/pi-tui"] = "^1.5.2"` (same range style as `pi-coding-agent`, so one pi-tui copy is installed) | public (package manifest) |
| `ApprovalRequest.overridable` (`src/interaction/approver.ts`) | modified | `overridable?: { units: string[]; current?: Record<string, { difficulty?: Difficulty; tags: string[] }> }` (in-memory only, not in the stored request yaml) | no |
| `AmendPlan` (`src/tools/unit-amend.ts`) | modified | `{ snapshot: AmendSnapshot; summary: string; current?: { difficulty?: Difficulty; tags: string[] } }` (set for edit and add, from the classified unit) | no |
| `Verdict`, `CANCELLED`, `Cancelled` (`src/interaction/flow-result.ts`) | modified (moved from `in-session.ts`, shapes unchanged) | `Verdict = Omit<Answered, "status" \| "by" \| "at" \| "adapter">`; `CANCELLED: unique symbol`; `Cancelled = typeof CANCELLED` | no |
| `menu.ts` exports | new | `BRIEFING_HEADING: Record<Briefing["author"], string>`; `briefingLines(b: Briefing, recommendedLabel?: string): string[]` (unneutralised lines; `titleWithBriefing` joins and neutralises them); `orderRecommended<T extends { id: string }>(choices: T[], recommended?: string): T[]`; `ENTRY_LABELS = { own: "write my own answer", later: "answer later (non-blocking)", answerNow: "answer now" }` (question entries; gate entries keep their labels from `gateChoices`); the fallback keeps `answerNow` for a question without candidates, the dialog uses `own` there, as the spec's "Question without candidates" requires | no |
| `DialogFactory<T>`, `DialogOutcome` (`src/interaction/dialog/types.ts`) | new | `DialogFactory<T> = (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => Component`; `DialogOutcome = { kind: "result"; result: Verdict \| Deferred } \| { kind: "cancelled" }` | no |
| `ApproverUI.dialog` (`src/interaction/approver.ts`) | modified | `dialog?: (factory: DialogFactory<DialogOutcome>) => Promise<DialogOutcome \| undefined>`; types via `import type` from `dialog/types.ts` | no |
| `ApproverCtx` (`src/tools/approver-for.ts`) | modified | `{ hasUI: boolean; mode?: ExtensionMode; ui: Omit<ApproverUI, "hasUI" \| "dialog"> & { custom?: <T>(factory: DialogFactory<T>) => Promise<T \| undefined> } }` | no |
| `DialogModel` (`src/interaction/dialog/model.ts`) | new | `{ kind: "gate" \| "question" \| "choice"; tabs: ("decision" \| "units" \| "review")[]; facts: string; status: { symbol: "✓" \| "!" \| "✗"; text: string }[]; briefing?: { heading: string; lines: string[] }; entries: DialogEntry[]; units: { unit: string; label: string; difficulty?: Difficulty; tags: string[] }[]; requirements: { id: string; label: string }[]; notes: boolean }` (`unit` and `id` stay raw because they are identity for overrides and `changesRequirement`; `label` is the sanitised display text; changed after the task 1 review | no |
| `DialogEntry` | new | `{ label: string; description?: string; recommended: boolean; action: { kind: "approve" } \| { kind: "changes" } \| { kind: "dismiss" } \| { kind: "option"; id: string } \| { kind: "candidate"; label: string } \| { kind: "own" } \| { kind: "later" } }` | no |
| `buildModel`, `toResult` (`dialog/model.ts`) | new | `buildModel(r: ApprovalRequest): DialogModel`; `toResult(model: DialogModel, state: DialogState, r: ApprovalRequest): Verdict \| Deferred \| Cancelled`; overrides emitted in `model.units` order | no |
| `sanitize` (`dialog/sanitize.ts`) | new | `(text: string) => string`: `neutralise`, then pi-tui `stripTerminalSequences`, then remove C0/C1 except `\n` `\t`, remove bidi controls (U+202A–202E, U+2066–2069), expand `\t` to two spaces | no |
| `DialogState` (`dialog/state.ts`) | new | `{ tab: number; focus: number; scroll: number; picked?: number; notes: string; answer: string; overrides: Readonly<Record<string, { difficulty?: Difficulty; tags?: string[] }>>; requirement?: { kind: "none" } \| { kind: "named"; name: string } \| { kind: "other"; text: string }; editor?: "note" \| "answer" \| "tags" \| "requirement"; error?: string; done?: "submitted" \| "cancelled" \| "deferred" }` (plain objects only, copy on write) | no |
| `DialogAction` (`dialog/state.ts`) | new | `{ type: "move"; delta: 1 \| -1 } \| { type: "scroll"; delta: number } \| { type: "pick"; index?: number } \| { type: "nextTab" } \| { type: "previousTab" } \| { type: "openEditor"; editor: "note" \| "answer" \| "tags" \| "requirement" } \| { type: "closeEditor"; text: string } \| { type: "cycleDifficulty"; delta: 1 \| -1 } \| { type: "pickRequirement"; index: number } \| { type: "submit" } \| { type: "cancel" }` (`pick` without index = the focused row) | no |
| `initialState`, `reduce`, `canSubmit` (`dialog/state.ts`) | new | `initialState(model): DialogState`; `reduce(model, state, action): DialogState`; `canSubmit(model, state): { ok: true } \| { ok: false; reason: string }` | no |
| `keyToAction` (`dialog/keys.ts`) | new | `(data: string, kb: KeybindingsManager, model: DialogModel, state: DialogState, field: { value(): string }) => DialogAction \| undefined`; with an editor open returns only `closeEditor(field.value())` on `tui.input.submit` and `cancel` on `tui.select.cancel`, else `undefined` (the host forwards the key to the field). Without an editor (refined in task 2): Enter on units → `nextTab`; on a question's review, digits and Enter pick the requirement row (`pickRequirement`) and Enter submits once the focused row is the picked one, since `pickRequirement` has no other key; `n` also opens the note on review | no |
| `DialogTheme`, `renderDialog`, `maxScrollOf` (`dialog/view.ts`) | new | `DialogTheme = { accent: (s: string) => string; muted: (s: string) => string; bold: (s: string) => string }`; `renderDialog(model, state, size: { width: number; height: number }, theme: DialogTheme, editorLines?: string[]): string[]`; internal deviation (task 2 review): `maxScrollOf(model, state, size): number` is the same layout math as `renderDialog`, and the host clamps `state.scroll` to it after each `scroll` action (`DialogAction` unchanged) | no |
| `TextField`, `createDialog` (`dialog/host.ts`) | new | `TextField = { value(): string; set(text: string): void; handleInput(data: string): void; render(width: number): string[]; focused: boolean }`; the host implements pi-tui `Focusable` and passes its `focused` to the open field, so the `Editor` draws its cursor; `createDialog(r: ApprovalRequest, makeField?: (tui: TUI, theme: Theme) => TextField): DialogFactory<DialogOutcome>`; default field wraps pi-tui `Editor` (`new Editor(tui, { borderColor: (s) => theme.fg("border", s), selectList: getSelectListTheme() })`, `value()` = `getExpandedText()`) | no |

---

## Task 1: Dialog model and state — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Modify: `package.json`, `bun.lock`, `src/interaction/approver.ts` (`overridable.current`), `src/core/change.ts` (`isDifficulty`), `src/subagents/build-loop.ts` (use it), `src/tools/spec-gate.ts`, `src/tools/unit-amend.ts`, `src/interaction/in-session.ts` (imports moved to `flow-result.ts`, shared labels; no behaviour change), `src/interaction/menu.ts`
- Create: `src/interaction/flow-result.ts`, `src/interaction/dialog/types.ts`, `src/interaction/dialog/sanitize.ts`, `src/interaction/dialog/model.ts`, `src/interaction/dialog/state.ts`
- Test: `tests/tools/spec-gate.test.ts`, `tests/tools/unit-amend.test.ts`, `tests/interaction/menu.test.ts`, `tests/interaction/dialog/model.test.ts`, `tests/interaction/dialog/state.test.ts`

**Interfaces:** Produces `overridable.current`, `AmendPlan.current`, `flow-result.ts`, the `menu.ts` exports, `DialogFactory`, `DialogOutcome`, `sanitize`, `DialogModel`, `DialogEntry`, `buildModel`, `toResult`, `DialogState`, `DialogAction`, `initialState`, `reduce`, `canSubmit`. Consumes `gateChoices` (`describe-actions.ts`), `failingWaivableOf` (`waive-rule.ts`), `neutralise` (`briefing.ts`). Entry order per kind matches today's flows: gate-like = `gateChoices(r)` ordered by `orderRecommended`; question = candidates (recommended first, if any), `ENTRY_LABELS.own`, `ENTRY_LABELS.later`; choice = `r.options`, recommended first.

- [ ] **Step 1:** Add the dependency: edit `package.json` (peer `"*"`, dev `"^1.5.2"`), run `bun install`, confirm `bun.lock` changed only for the root entry and `bun pm ls | grep pi-tui` shows one copy.
- [ ] **Step 2:** Failing tests: `gateRequest` for `plan` sets `overridable.current` from `state.change.units` (`difficulty` narrowed with an `isLevel`-style guard, left out when not a level; `tags ?? []`); `amendRequest` for edit/add sets `current` for its unit from `AmendPlan.current`; drop has no `overridable`. Run them — FAIL. Implement in `approver.ts`, `spec-gate.ts`, `unit-amend.ts` (`contractSnapshot` returns the classified unit's values with the snapshot; the level guard is extracted from `subagents/build-loop.ts:36` into a shared `isDifficulty` in `src/core/change.ts` and reused there). Run `bunx vitest run tests/tools/spec-gate.test.ts tests/tools/unit-amend.test.ts` — PASS.
- [ ] **Step 3:** Refactor without behaviour change: create `flow-result.ts` and import it in `in-session.ts`; export `BRIEFING_HEADING`, `briefingLines`, `orderRecommended`, `ENTRY_LABELS` from `menu.ts` and make `menuEntries`, `titleWithBriefing` and the question/gate flows use them; add `menu.test.ts` cases for `orderRecommended` and `briefingLines`. Run `bunx vitest run tests/interaction tests/tools` — PASS (existing in-session tests unchanged).
- [ ] **Step 4:** Failing tests in `model.test.ts`: define gate → tabs `["decision","review"]`, entries approve/changes/dismiss with descriptions, recommended first; plan gate with `overridable` → tabs include `units` with values from `current` (a unit missing from `current` has no `difficulty` and `tags: []`); gate with a failing waivable check → no approve, one `waive` entry, and a `status` row `{ symbol: "!", text: … spec-lint … }`; question with candidates → candidates, own, later; "Question without candidates" → only own and later; stuck with B recommended → B first and marked; `decide:` ask → choice kind, `notes: false`; briefing heading `Agent recommendation (agent-authored, advisory)` vs `Livespec rule recommendation`; "strips control characters" (`\x1b[2J` removed whole, `\x1b]0;x\x07`, `\r`, `\u202e` removed from summary, briefing, labels and descriptions; `\n` kept; `\t` expanded).
- [ ] **Step 5:** Failing `toResult` tests: approve + empty notes → `approved`; approve + notes → `approved_with_notes`; option `waive` → `choice: "waive"`; changes + notes → `changes_requested`; overrides hold only fields that differ from `current`, in `model.units` order ("Value set back to the current one": cycled back → no override); "Overrides discarded with request changes": changes + notes + a changed unit → no `overrides`; candidate → `answer` = label, `questionClass` from `r.question.class`, `changesRequirement` from the requirement pick ("Question answered in the dialog"); own answer trimmed ("Own answer typed in the dialog"); later → `{ status: "deferred", questionClass: "non-blocking" }`; dismiss → `CANCELLED`; stuck B → `{ outcome: "approved", notes: "", choice: "B" }`.
- [ ] **Step 6:** Run `bunx vitest run tests/interaction/dialog/model.test.ts` — FAIL. Implement `dialog/types.ts`, `sanitize.ts` and `model.ts` (one builder per kind; per-kind result functions; split `toResult` into `dialog/result.ts` if `model.ts` passes ~250 lines). PASS.
- [ ] **Step 7:** Failing tests in `state.test.ts`: `move` wraps within entries; `pick` with an index selects entry n; `pick` on a gate entry moves to the next tab; `pick` changes with an empty note opens the note editor; `canSubmit` "blank note blocks submit" (notes `"  "` → not ok); `submit` only on the review tab and only when `canSubmit` is ok, else `error` set; a question without a requirement pick, with an empty typed answer or an empty typed requirement → not ok; `pickRequirement` sets `none`/`named` and the `other` index opens the requirement editor; "Review shows the answer before it is sent" (pick `waive`, move to review → `done` unset, `picked` is the waive entry); review state exposes discarded overrides when `changes` is picked; `pick` later → `done: "deferred"` at once; `pick` dismiss → `done: "cancelled"`; `cancel` with no editor → `done: "cancelled"`; "Esc in the note editor" (`cancel` with `editor: "note"` → editor closed, `done` unset, notes kept); `closeEditor(text)` stores the text in the open editor's field; `cycleDifficulty` from undefined → `low`, then low→medium→high→low; `closeEditor` on tags parses `a, b` into `["a","b"]`; `scroll` clamps at 0; `nextTab`/`previousTab` wrap; "state never mutated" (deep-frozen input incl. `overrides`).
- [ ] **Step 8:** Run — FAIL. Implement `state.ts` as one `reduce` dispatching to small handlers per action, with `canSubmit` separate. PASS. `bun run typecheck` — PASS.
- [ ] **Step 9:** Commit in two commits: after Step 3 `refactor(interaction): current unit values and shared menu helpers`, after Step 8 `feat(interaction): dialog model and state for in-session requests`.

---

## Task 2: Dialog keys, view and host component — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4
**Difficulty:** Hard
**Blocked by:** Task 1

**Files:**
- Create: `src/interaction/dialog/keys.ts`, `src/interaction/dialog/view.ts`, `src/interaction/dialog/host.ts`
- Test: `tests/interaction/dialog/keys.test.ts`, `tests/interaction/dialog/view.test.ts`, `tests/interaction/dialog/host.test.ts`

**Interfaces:** Consumes Task 1 contracts. Produces `keyToAction`, `DialogTheme`, `renderDialog`, `TextField`, `createDialog`. The editor is the single owner of the text being typed: `host.ts` forwards every key to the open `TextField` unless `keyToAction` returns `closeEditor`/`cancel`; Enter never reaches the `Editor`. The host maps `theme.fg("accent"|"muted", s)` and `theme.bold` into `DialogTheme`, reads the height from `tui.terminal.rows` (`rows - 4`, at least 10), calls `tui.requestRender()` after each key, and calls `done` exactly once. The host is `Focusable`: its `focused` flag is passed to the open field so the `Editor` emits its cursor marker.

- [ ] **Step 1:** Failing tests in `keys.test.ts` with a stub `KeybindingsManager` (`matches(data, id)` from a table): up/down → `move`; `3` → `pick 2` (also the Kitty CSI-u encoding of `3`, via `decodeKittyPrintable`); `n` → `openEditor note` only when `model.notes` is true, ignored otherwise; Tab → `nextTab`, Shift+Tab → `previousTab`; Enter (`tui.select.confirm`) → `pick` on decision, `submit` on review; Esc → `cancel`; PageUp/PageDown → `scroll`; `←`/`→` on the units tab → `cycleDifficulty`; `e` on the units tab → `openEditor tags`; with an editor open: `n`, digits, Backspace → `undefined` (forwarded), `tui.input.submit` → `closeEditor(field.value())`, Esc → `cancel`.
- [ ] **Step 2:** Run — FAIL. Implement `keys.ts`. PASS.
- [ ] **Step 3:** Failing tests in `view.test.ts` with an identity theme: 80-column define gate snapshot ("Briefing section in the dialog": tab strip with the active tab in `[ ]` as well as bold, facts, blank line, briefing heading and lines, blank line, `› 1 approve (Recommended)` with the description indented below, note line `Note: — (n: add)`, key hints); "Medium width hides descriptions and hints" at 50 columns; width boundaries 59/60 and 39/40; "Status without colour" (failing waivable check line starts with `!`); "Narrow terminal" at 35 columns → one line containing `widen` and `Esc`; "Long briefing scrolls" (40-line facts, height 20 → every entry line present, facts cut from the top by `state.scroll`); "lines never exceed width" with CJK, emoji and tab-containing agent text at 40/50/80 columns (`visibleWidth(line) <= width`); "no escape sequences in output"; review tab for a `waive` pick lists the waive label; review tab shows notes, overrides, and discarded overrides with `changes`; units tab shows `U1  low  [security]` and `U2  —  []` for a unit without current values; an open editor's lines are drawn in place of the note line.
- [ ] **Step 4:** Run — FAIL. Implement `view.ts` as small section renderers (tabs, body, entries, units, review, footer) composed by `renderDialog`. PASS.
- [ ] **Step 5:** Failing tests in `host.test.ts` driving `createDialog(r, fakeField)` with a fake `tui` (`requestRender` spy, `terminal.rows`), identity theme, stub keybindings and a fake `done`: define gate Enter, Enter → `done` once with `approved`; `n`, keys `o` `k` forwarded to the field, submit, Enter, Enter → `approved_with_notes` `ok`; backspace and a multi-line paste are forwarded to the field, not to the reducer; changes script: `2` → editor open → submit with empty field → editor closes → Tab to review → Enter → no `done`, `error` set; Esc → `{ kind: "cancelled" }`; stuck request Esc → cancelled ("Esc cancels the dialog"); question "answer later" → `{ kind: "result", result: deferred }` without review; `render(80)` uses the terminal rows for height.
- [ ] **Step 6:** Run — FAIL. Implement `host.ts` (default field from pi-tui `Editor` as in Contracts). PASS. `bun run typecheck` — PASS.
- [ ] **Step 7:** Commit `feat(interaction): dialog keys, view and host component`.

---

## Task 3: Adapter wiring and fallback — implements 3

**Covers:** 3.1, 3.2, 3.3
**Difficulty:** Normal
**Blocked by:** Task 2

**Files:**
- Modify: `src/interaction/approver.ts`, `src/tools/approver-for.ts`, `src/interaction/in-session.ts`
- Test: `tests/interaction/in-session.test.ts`, `tests/tools/approver-for.test.ts` (create), `tests/tools/spec-gate.test.ts`

**Interfaces:** Consumes `createDialog`, `DialogOutcome`, `DialogFactory`. Modifies `ApproverUI` (`dialog?`) and `ApproverCtx` (`mode?`, `ui.custom?`). In `createInSessionApprover.request`: when `ui.dialog` is set, `const out = await ui.dialog(createDialog(r))`; `out === undefined` → run `flowFor(r)` (fallback); `out.kind === "cancelled"` → `DISMISSED`; else use `out.result`. Building `Answered` stays in one place.

- [ ] **Step 1:** Failing tests in `approver-for.test.ts`: ctx with `mode: "tui"` and `ui.custom` → `ApproverUI.dialog` defined and it calls `ui.custom` with the factory; `mode: "rpc"` → `dialog` undefined; `mode: "tui"` without `ui.custom` → undefined.
- [ ] **Step 2:** Failing tests in `in-session.test.ts`: "Dialog in the TUI" (fake `dialog` returning a result → no `select`/`input` calls); "Fallback when the dialog draws nothing" (stuck request, fake `dialog` resolving `undefined` → select chain runs and its answer is used); "explicit cancel is not a fallback" (`{ kind: "cancelled" }` → `dismissed`, no select call); "Empty required text in the fallback" (select path, changes with empty notes → `dismissed`, existing behaviour pinned); "dialog and select chain agree": for a define gate, a plan gate with overrides, a question with candidates, a stuck report and a `decide:` ask, drive the real dialog (`createDialog` with fake tui/keys/field, scripted keys) and the scripted select chain with the same choices, and compare the `Answered` objects minus `at` (overrides in `overridable.units` order).
- [ ] **Step 3:** Run — FAIL. Implement the `ApproverUI.dialog` field, `uiOf` in `approver-for.ts` (`dialog: (factory) => ctx.ui.custom(factory)` only under the guard), and the branch in `in-session.ts`. PASS.
- [ ] **Step 4:** Add to `spec-gate.test.ts` "define in RPC mode uses select" (ctx `mode: "rpc"`, a `custom` spy never called, the scripted select answers) and "define in TUI mode uses the dialog": tool ctx with `mode: "tui"` and a `custom` stub that runs the factory and feeds `Enter Enter` → gate approved, adapter `in-session`. Run `bunx vitest run tests/tools tests/interaction` and `bun run typecheck` — PASS.
- [ ] **Step 5:** Commit `feat(in-session): one dialog per request in the TUI, select chain as fallback`.

---

## Task 4: Docs and changelog — implements 4

**Covers:** 4.1, 4.2
**Difficulty:** Easy
**Blocked by:** Task 3

**Files:**
- Modify: `README.md`, `README.vi.md`, `docs/architecture.md`, `CHANGELOG.md`

**Interfaces:** none.

- [ ] **Step 1:** `README.md` line ~248: in-session row says "one dialog per request in the pi TUI (tabs Decision, Adjust units, Review); select dialogs in RPC hosts"; add a short "Dialog keys" list (`↑↓`, `1-9`, `n`, `Tab`, `Enter`, `Esc`); line ~138 wording. Same in `README.vi.md` in Vietnamese.
- [ ] **Step 2:** `docs/architecture.md` interaction section (~line 152): add the `dialog/` modules (model, state, keys, view, host), the `ApproverUI.dialog` guard (`ctx.mode === "tui"`), and the `undefined` fallback.
- [ ] **Step 3:** `CHANGELOG.md` Unreleased: Added "In-session dialog: …"; Changed "`@earendil-works/pi-tui` is a peer dependency".
- [ ] **Step 4:** Run `bun run typecheck`, `bun run test`, `openspec validate --specs` — PASS.
- [ ] **Step 5:** Commit `docs: in-session dialog`.

---

## Scenario → test

approver-adapters:
- Approve in the TUI → `tests/interaction/in-session.test.ts` existing "approve" case (select path) and `tests/tools/spec-gate.test.ts` "define in TUI mode uses the dialog"
- Unavailable without UI → existing `tests/interaction/chain.test.ts` case (unchanged)
- Answer later in session → existing `tests/tools/spec-question.test.ts` case (select path); `host.test.ts` "answer later" (dialog path)
- Question candidate picked in session → existing `in-session.test.ts` case; `in-session.test.ts` "dialog and select chain agree" (question)
- Own answer instead of a candidate → existing `in-session.test.ts` case
- Dialog in the TUI → `in-session.test.ts` "Dialog in the TUI"
- Select chain in RPC mode → `approver-for.test.ts` "`mode: rpc` → no dialog" and `spec-gate.test.ts` "define in RPC mode uses select"
- Fallback when the dialog draws nothing → `in-session.test.ts` "Fallback when the dialog draws nothing"
- Empty required text in the fallback → `in-session.test.ts` "Empty required text in the fallback"
- Same answer on both paths → `in-session.test.ts` "dialog and select chain agree" (plan gate with overrides)
- Approve through Review → `host.test.ts` "define gate Enter Enter"
- Review shows the answer before it is sent → `state.test.ts` "Review shows the answer before it is sent" and `view.test.ts` review tab `waive` case
- No unit tab without overridable units → `model.test.ts` define gate tabs
- Answer later skips Review → `state.test.ts` "`pick` later"
- Esc cancels the dialog → `state.test.ts` "`cancel` with no editor" and `host.test.ts` stuck Esc case
- Esc in the note editor → `state.test.ts` "Esc in the note editor"
- Approve with notes → `host.test.ts` note `ok` case
- Request changes needs a note → `state.test.ts` "`pick` changes with an empty note" and "blank note blocks submit", `host.test.ts` changes script
- Unit overrides on their own tab → `model.test.ts` plan gate tabs and `toResult` overrides case
- Value set back to the current one → `model.test.ts` "Value set back to the current one"
- Overrides discarded with request changes → `model.test.ts` "Overrides discarded with request changes" and `view.test.ts` review tab discarded line
- Question answered in the dialog → `model.test.ts` "Question answered in the dialog" and `state.test.ts` `pickRequirement` case
- Own answer typed in the dialog → `model.test.ts` "Own answer typed in the dialog"
- Question without candidates → `model.test.ts` "Question without candidates"
- Stuck choice in the dialog → `model.test.ts` stuck B case
- Narrow terminal → `view.test.ts` "Narrow terminal"
- Medium width hides descriptions and hints → `view.test.ts` "Medium width hides descriptions and hints"
- Status without colour → `view.test.ts` "Status without colour"
- Long briefing scrolls → `view.test.ts` "Long briefing scrolls"
- Terminal control characters in agent text → `model.test.ts` "strips control characters" and `view.test.ts` "no escape sequences in output"

request-briefing:
- Recommended entry first → existing `tests/interaction/menu.test.ts` and `in-session.test.ts` cases; `model.test.ts` stuck B first
- Briefing shown before options → existing `in-session.test.ts` title case (select path)
- Briefing section in the dialog → `view.test.ts` 80-column define gate snapshot
