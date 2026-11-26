## 1. Dialog model and state

Blocked by: none

- [ ] 1.1 Add `@earendil-works/pi-tui` to `peerDependencies` (`"*"`) and `devDependencies` (`^1.5.2`) in `package.json`, refresh `bun.lock` with `bun install`
- [ ] 1.2 Carry current unit values: `ApprovalRequest.overridable.current` in `src/interaction/approver.ts`, filled by `spec_gate plan` (`src/tools/spec-gate.ts`) from the change's units and by `unit_amend` (`src/tools/unit-amend.ts`, `AmendPlan.current`) from the classified unit, Difficulty narrowed to `low|medium|high`; tests in `tests/tools/spec-gate.test.ts` and `tests/tools/unit-amend.test.ts`
- [ ] 1.3 Move `Verdict`, `CANCELLED`, `Cancelled` from `src/interaction/in-session.ts` to `src/interaction/flow-result.ts`; export the briefing heading/lines, the recommended-first ordering and shared entry labels from `src/interaction/menu.ts`, with `menuEntries`/`titleWithBriefing` and the existing flows using them (no behaviour change)
- [ ] 1.4 Create `src/interaction/dialog/model.ts`: build a `DialogModel` from an `ApprovalRequest` per request kind (gate-like, question, stuck/decide) with tabs, sections, ordered entries (reusing `gateChoices`, `menuEntries` ordering, `neutralise` plus control-character stripping) and turn a submitted `DialogState` into `Verdict | Deferred | Cancelled` with the rules of the current `gateFlow`/`questionFlow`/`choiceFlow`
- [ ] 1.5 Create `src/interaction/dialog/state.ts`: `DialogState` and the pure `reduce(state, action)` (move, scroll, pick, next/previous tab, open/close editors with their committed text, cycle difficulty, pick requirement change, submit, cancel) and a separate pure `canSubmit` with the validation of approver-adapters "Dialog notes", "Dialog unit overrides", "Dialog questions" and "Dialog exits without Review"
- [ ] 1.6 Tests in `tests/interaction/dialog/model.test.ts` and `tests/interaction/dialog/state.test.ts` for every request kind, the Review gate on submit, `changes` needing a note, overrides only for changed units, answer later and dismiss exits, Esc in an editor, and control characters stripped from agent text

## 2. Dialog keys, view and host component

Blocked by: 1

- [ ] 2.1 Create `src/interaction/dialog/keys.ts` mapping input to actions through the injected `KeybindingsManager` (`tui.select.*`, `tui.input.submit`, `tui.input.newLine`) plus `1`–`9`, `n`, `Tab`/`Shift+Tab`, `←`/`→` on unit rows and `e` for tags; editor mode routes text to the field
- [ ] 2.2 Create `src/interaction/dialog/view.ts`: pure `renderDialog(model, state, size, theme, editorLines?)` with the agreed layout (tabs, facts, briefing under its author heading, numbered entries with descriptions, note line, key hints), scrolling body above fixed entries, the 60/40-column rules and status symbols that do not rely on colour
- [ ] 2.3 Create `src/interaction/dialog/host.ts`: the `Component` that owns the state, wraps pi-tui `Editor` behind a small text-field interface for notes and typed answers, and resolves `done` with the flow result or an explicit cancelled marker
- [ ] 2.4 Tests in `tests/interaction/dialog/keys.test.ts`, `view.test.ts` (fixed-width snapshots at 80, 50 and 35 columns, long-payload scrolling, CJK and emoji width, escape sequences absent) and `host.test.ts` (scripted key sequences to results)

## 3. Adapter wiring and fallback

Blocked by: 2

- [ ] 3.1 Add the optional `dialog` entry to `ApproverUI` in `src/interaction/approver.ts`; set it in `src/tools/approver-for.ts` only when `ctx.mode === "tui"` and `ctx.ui.custom` is a function, widening `ApproverCtx` with `mode` and `ui.custom`
- [ ] 3.2 In `src/interaction/in-session.ts`, run the dialog when `ui.dialog` is present and fall back to the existing `select`/`input` flow when it is absent or resolves `undefined` without input; keep `Answered` construction in one place
- [ ] 3.3 Tests in `tests/interaction/in-session.test.ts` and `tests/tools/approver-for.test.ts` for TUI vs RPC selection, the `undefined` fallback, and equivalence: the same choices through the dialog and the select chain give identical answers for a define gate, a plan gate with overrides, a question with candidates, a stuck report and a rule ask

## 4. Docs and changelog

Blocked by: 3

- [ ] 4.1 Update `README.md` and `README.vi.md` (in-session adapter row, dialog keys, fallback in RPC/print), `docs/architecture.md` (interaction section: dialog modules and fallback) and `CHANGELOG.md` Unreleased (Added: in-session dialog; Changed: `@earendil-works/pi-tui` peer dependency)
- [ ] 4.2 Run `bun run typecheck`, `bun run test` and `openspec validate --specs`; fix any failure
