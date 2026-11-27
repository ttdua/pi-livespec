# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `interaction-contract`
**Iteration**: `2`
**Applied at**: `2026-11-27 15:48` (UTC)
**Executor**: `subagent-driven-development` (implementer `superspec.implementer`, task reviewer `superspec.task-reviewer`)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.interaction-contract`
- **Worktree branch**: `interaction-contract`
- **Feature branch**: `issue-65`
- **Base branch**: `main`

---

## Commits

- **Range**: `0f03d93..2792fc9`, plus this receipt commit (iteration 1: `0f03d93..d9c193c`; verify receipt `56f6c6b`; iteration 2: `56f6c6b..2792fc9`)
- **Count**: `23`, plus the receipt commit

Validation at `2792fc9`:
- `bunx vitest run`: 4148 tests pass (the baseline was 258 files / 4062 tests).
- `bunx tsc --noEmit` is clean.
- `openspec validate interaction-contract --strict` reports the change valid, with exit 0.

---

## Tasks

- **Completed**: `24 of 24` checkboxes in tasks.md flipped to `- [x]`.
- **Remaining**: none.

---

## Contract deviations

- `GateOption.description` (`src/engine/gates.ts`): now required. Registered named-gate options must be described so `spec_gate` builds requests that pass the construction guard. Internal.
- `amendRequest(..., briefing)`: the `briefing` parameter is now required, because production always passes one. Internal.
- `DialogModel.tabs` / `tabsOf(model, state)`: `tabs` holds only decision and review, and `tabsOf` in `state.ts` adds `units` once `unitsOpen`. Internal.
- `EffectDeps.ask` / `reask` (`src/review/effects.ts`): they take `SpecQuestionParams` instead of a string, so routing questions carry the fixed candidates. Internal.
- `escalationForecast` now also returns `waivable`, the failing waivable checks, which the next step names. Internal.
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
| 8 (iteration 2) | sequential | `71cb69c..4a8bb6d` | Approved after fix round 1 | n/a |
| iteration 2 review | sequential | `56f6c6b..2792fc9` | "Ready with fixes" → spec wording restored (`2792fc9`) | n/a |

---

## Rulings

- Tasks ran sequentially in one worktree with no parallel lanes, because shared test helpers and suite-wide fixture changes (Tasks 4 and 5) made merge conflicts likely. Cost if wrong: wall time only.
- `spec_question` lists `candidates`, `recommended` and `rationale` in the schema's `required`, so pi's validator may refuse with its generic message before the tool's own refusal. Cost: refusal wording only.
- The Task 5 review minors (rule consulted via `decide`, self gate ignores the briefing, the self forecast caveat) were literal spec deviations, so they were fixed in a loop rather than deferred.
- Left as follow-ups from iteration 1 (the S items were resolved in iteration 2): the legacy stuck briefing keeps author `agent`.
- The new-dependency approve is described as "Same as option A" instead of no longer offering approve. This keeps the existing `/livespec approve` behaviour.

---

## Iteration 2

Iteration 2 addressed the verify iteration 1 items, by the user's choice (option 1):
- **W1:** the long ADDED requirements were split or condensed. `openspec validate --strict` now exits 0.
- **S1:** a failing waivable check at the escalating plan gate is reported as an escalation when the forecast is `human`. A new flow-engine delta changes the exception to rule 12 of "Next step precedence".
- **S2:** `advisory_review` now covers every `always` advisory reviewer. The new decision-seam requirement is "Advisory review state".
- **S3:** the `escalateOrPass` helper was extracted from `runSpecGate`.
- **S4:** the unused `r`, the dead `DialogHost.r` field and the unused import were removed.
- **W2:** kept as a documented limitation (design D4); it needs a follow-up issue.

Ruling: the `failingCheck` exception applies only when the forecast is `human`. Otherwise a custom rule returning `self`, or a missing rule, would hide a "Fix" step behind a false "can pass". Cost if wrong: none, because the built-in rule always returns `human` when a waivable check fails.

---

## Next step

Run `/opsx-verify`.
