# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `interaction-contract`
**Iteration**: `1`
**Applied at**: `2026-11-27 15:03` (UTC)
**Executor**: `subagent-driven-development` (implementer `superspec.implementer`, task reviewer `superspec.task-reviewer`)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.interaction-contract`
- **Worktree branch**: `interaction-contract`
- **Feature branch**: `issue-65`
- **Base branch**: `main`

---

## Commits

- **Range**: `0f03d93..14b7243`, plus this receipt commit
- **Count**: `16`, plus the receipt commit

Validation at `14b7243`:
- `bunx vitest run`: 261 files and 4140 tests pass (the baseline was 258 files / 4062 tests).
- `bunx tsc --noEmit` is clean.
- `openspec validate interaction-contract --strict` reports no errors (only requirement-length warnings).

---

## Tasks

- **Completed**: `20 of 20` checkboxes in tasks.md flipped to `- [x]`.
- **Remaining**: none.

---

## Contract deviations

- `GateOption.description` (`src/engine/gates.ts`): now required. Registered named-gate options must be described so `spec_gate` builds requests that pass the construction guard. Internal.
- `amendRequest(..., briefing)`: the `briefing` parameter is now required, because production always passes one. Internal.
- `DialogModel.tabs` / `tabsOf(model, state)`: `tabs` holds only decision and review, and `tabsOf` in `state.ts` adds `units` once `unitsOpen`. Internal.
- `EffectDeps.ask` / `reask` (`src/review/effects.ts`): they take `SpecQuestionParams` instead of a string, so routing questions carry the fixed candidates. Internal.
- Main merged #73 (question-cascade) before apply. The delta specs were rebased on it: `--changes` and the requirement step were already gone, and the class flag scenarios were adjusted. This was recorded before step 0.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | sequential | `0f03d93..5765e73` | Approved | n/a |
| 2 | sequential | `afd132f..3240f94` | Approved | n/a |
| 3 | sequential | `72e0ef3..3411fce` | Approved | n/a |
| 4 | sequential | `19266b7..5f0309c` | Approved | n/a |
| 5 | sequential | `676caa6..b69f952` | Approved after fix round 1 | n/a |
| 6 | sequential | `484119d..3558f50` | Approved | n/a |
| 7 | sequential | `b510313..b249ed0` | Approved | n/a |
| final | sequential | `3ed8c32..14b7243` | Whole-branch review "Ready with fixes" → fix wave, re-review Approved | n/a |

---

## Rulings

- Tasks ran sequentially in one worktree with no parallel lanes, because shared test helpers and suite-wide fixture changes (Tasks 4 and 5) made merge conflicts likely. Cost if wrong: wall time only.
- `spec_question` lists `candidates`, `recommended` and `rationale` in the schema's `required`, so pi's validator may refuse with its generic message before the tool's own refusal. Cost: refusal wording only.
- The Task 5 review minors (rule consulted via `decide`, self gate ignores the briefing, the self forecast caveat) were literal spec deviations, so they were fixed in a loop rather than deferred.
- Left as follow-ups:
  - The `failingCheck` next-step rule still precedes the gate step, so a failing `size-limits` says "fix" rather than "the gate will ask the human".
  - The escalation facts use only the first advisory `always` reviewer.
  - `runSpecGate` is long.
  - The legacy stuck briefing keeps author `agent`.
  - `outcomeOf` has an unused `r` parameter, and `result.ts` has an unused type import.
- The new-dependency approve is described as "Same as option A" instead of no longer offering approve. This keeps the existing `/livespec approve` behaviour.

---

## Next step

Run `/opsx-verify`.
