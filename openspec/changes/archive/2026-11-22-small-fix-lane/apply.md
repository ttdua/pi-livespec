# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `small-fix-lane`
**Iteration**: `1`
**Applied at**: `2026-11-22 03:40`
**Executor**: `subagent-driven-development` (implementer `superspec.implementer`, task reviewer `superspec.task-reviewer`; final whole-branch review by `superspec.task-reviewer`; no model override)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.small-fix-lane`
- **Worktree branch**: `small-fix-lane`
- **Feature branch**: `LS-09b`
- **Base branch**: `main`

---

## Commits

- **Range**: `f756373..5d372b7` (this receipt's commit follows `5d372b7`)
- **Count**: `21`

---

## Tasks

- **Completed**: `23 of 23` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

Validation at `5d372b7`: `bun run typecheck` exit 0; `bunx vitest run` 3071/3071 passing (210 files).

---

## Contract deviations

All internal; no `public` contract changed.

- `fixRange` (src/fix/branch.ts): added `fixRange(git, integration): Promise<{ mergeBase; subjects }>` and `DIRTY_TREE_REFUSAL`, shared by `fix_ship` and `change_new --from-fix` (Task 5 review: duplicated merge base + subjects logic).
- `fixNextStep` row: added shared formatters `fixLaneText` (src/hooks/phase-card.ts) and `formatFix` / `fixDetails` (src/tools/format-step.ts) so the card, `spec_next`, `spec_status` and `/livespec next` print the same text (Task 6).
- `prepareWrite` (src/tools/guard.ts): on a fix card it runs one tracked forge read (`whoami`, errors ignored) before `requireWritable`, so fix writes see read-only mode without the card calling the forge (Task 6 review).
- `fixIntegration` / `fixBranchName` / `fixIntegrationTip` (src/fix/branch.ts): one integration-branch resolution and message for `fix_start`, `fix_ship`, `change_new --from-fix` and the fix card (final review I2).
- `laneConfigOf` and optional `RuleSchema.complete` (src/fix/lane.ts, src/decide/registry.ts, src/engine/pack-load.ts): the merged or standalone pack must hold both `max_files` and `max_lines`; `fix_ship` refuses and the card shows an error when `decisions.lane` is missing or incomplete (final review I1).
- `CardInput` fix kind memo key: HEAD + integration branch + local `origin/<integration>` tip (final review M2).
- `CHANGE_BRANCH_PREFIX` exported from src/engine/resolve-change.ts and reused (Task 5 review).

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 Config, git and decision ports | sequential | `f756373..7d1d499` | Approved (2 minor) | n/a |
| 2 Lane rule | sequential | `99ad8d4..e1842ea` | Approved (3 minor) | n/a |
| 3 Fix start | sequential | `30c8e3f..3e3f800` | Approved after fix round 1 | n/a |
| 4 Fix ship | sequential | `38b4a4e..a9f03cc` | Approved after fix round 1 | n/a |
| 5 Move a fix into a change | sequential | `d1e1e7b..dc227dd` | Approved after fix round 1 | n/a |
| 6 Fix card | sequential | `50921b7..d21f5bb` | Approved after fix round 1 | n/a |
| 7 Bare work | sequential | `8658d96..fb63027` | Approved (5 minor) | n/a |
| 8 Docs and end-to-end check | sequential | `e8672ee..8ca6bdf` | Approved (3 minor) | n/a |
| Final whole-branch review | sequential | `f756373..8ca6bdf`, fix wave `5fa2b16..5d372b7` | With fixes → fix wave Approved | n/a |

---

## Next step

Run `/opsx-verify`. Open question for the user, parked (not in scope): `change_new --from-fix` on a fix with no commit after the merge base still creates a `define` issue; the spec is silent.
