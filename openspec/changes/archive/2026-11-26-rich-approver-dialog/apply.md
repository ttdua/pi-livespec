# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `rich-approver-dialog`
**Iteration**: `1`
**Applied at**: `2026-11-26 11:26` (UTC)
**Executor**: `subagent-driven-development` (sequential lanes; implementer `superspec.implementer`, task reviewer `superspec.task-reviewer`; small review fixes by the parent with TDD)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.rich-approver-dialog`
- **Worktree branch**: `rich-approver-dialog`
- **Feature branch**: `spec/rich-approver-dialog`
- **Base branch**: `main`

---

## Commits

- **Range**: `64cb766..dfa175f` plus the commit of this receipt
- **Count**: `20` before this receipt, including merge commit `9e1126e` (`origin/main` at `61848a4`, PR #55, merged into the worktree branch with the user's approval before Task 3; conflicts in `src/interaction/menu.ts`, `src/tools/unit-amend.ts` and `tests/interaction/menu.test.ts` were resolved by keeping the Task 1 structure and applying #55's whole-title/label neutralisation and `summary: record.summary`)

---

## Tasks

- **Completed**: `15 of 15` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

---

## Contract deviations

- `package.json` dev dependency: `@earendil-works/pi-tui` uses `^1.5.2` (plan review, before apply), so only one pi-tui copy is installed; peer stays `"*"` as approved.
- `DialogModel.units` / `DialogModel.requirements` (internal, Task 1 review): units gain `label`, requirements become `{ id; label }[]`, so identity stays raw and only labels are sanitised; overrides and `changesRequirement` match the select path.
- `DialogEntryAction` (internal, Task 1): a name for the entry action union in `model.ts`, to keep it apart from the reducer's `DialogAction`; shape as in Contracts.
- `toResult` home (internal, Task 1): lives in `dialog/result.ts` and is re-exported from `model.ts`, as plan Step 6 allows.
- `keyToAction` behaviour (internal, Task 2): Enter on the units tab moves to the next tab; on a question's review digits and Enter pick the requirement row, and Enter submits once the focused row is picked; `n` also opens the note on review. Signature unchanged.
- `maxScrollOf` (internal, Task 2 review): exported from `view.ts`; the host clamps `state.scroll` with it, starting from the previous offset so one PgUp always moves the body.
- `outcomeLabel` (internal, Task 2 review): exported from `result.ts` and shared with `toResult`, so the Review tab cannot disagree with the sent outcome.
- `TextField.invalidate?` (internal, Task 2 review): forwarded to the `Editor` on theme changes.
- `ApproverCtx` (internal, Task 3): `mode` typed as `ExtensionContext["mode"]` because pi does not export `ExtensionMode` from its root; `uiOf` exported for tests; `ui.custom` takes `options?: { blocked }` and `uiOf` passes `blocked: { kind: "question", … }` so terminals with program status show pi as waiting (Task 3 review); a type test checks pi's `ExtensionContext` is assignable without a cast.
- `createDialog` default field (internal, Task 3 review): the `Editor`'s select-list colours are built from the injected theme instead of importing `getSelectListTheme` from pi-coding-agent at runtime.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| Task 1 — Dialog model and state | `sequential` | `64cb766..de5b987` (tick `b6e44b9`) | Ready with fixes → Ready (fixes `de5b987`) | n/a |
| Task 2 — Dialog keys, view and host | `sequential` | `b6e44b9..3a86e01` (tick `e804fa7`) | Ready with fixes → Ready (fixes `fbf3155`, `9d85831`, `3a86e01`) | n/a |
| Merge `origin/main` (PR #55) | `sequential` | `e804fa7..9e1126e` | resolution reviewed in the final review | `9e1126e` |
| Task 3 — Adapter wiring and fallback | `sequential` | `9e1126e..14d7364` (tick `ba0e9de`) | Ready with fixes (4 MINOR, fixed in `14d7364`) | n/a |
| Task 4 — Docs and changelog | `sequential` | `ba0e9de..545e04b` (tick `44458ae`) | covered by the final review | n/a |
| Final whole-branch review | — | `64cb766..44458ae` | Ready with fixes; IMPORTANT #1 (focused row cut off when many rows overflow) and MINOR #2 (unused import) fixed in `dfa175f` | n/a |

Final review items left as follow-ups (MINOR, not required by the specs):
- the select path records an override equal to the current value, while the dialog drops it (the spec's equivalence covers changed values only);
- small duplications: `gateAction` in `in-session.ts` and `model.ts`, difficulty level lists in `in-session.ts`, `state.ts`, `core/change.ts`, `commands.ts`, `core/validate-units.ts`, and `BRIEFING_HEADING` in `forge-text.ts`;
- `host.ts` height floor of 10 rows exceeds very short terminals;
- a rejected `ui.dialog` promise errors the tool call instead of falling back to select;
- `initialState(_model)` keeps its Contracts signature with an unused parameter.

Not verified in apply: the dialog in a real pi TUI terminal (all tests are headless); listed for verify.

---

## Next step

Run `/opsx-verify` in the worktree.
