# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `sync-ls05-artifacts`
**Iteration**: `1`
**Applied at**: `2026-11-16 14:40` (2026-11-16T14:40:00Z)
**Executor**: `subagent-driven-development`:
- **Implementer:** the `implementer` agent.
- **Task reviewer and final whole-branch reviewer:** the `code-reviewer` agent.
- **Models and thinking levels:** the configured models, with no per-dispatch model override. The thinking level follows each task's Difficulty.

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.sync-ls05-artifacts`
- **Worktree branch**: `sync-ls05-artifacts`
- **Feature branch**: `ls-05-20`
- **Base branch**: `main`

---

## Commits

- **Range**: `5528b42..52a71f4` (the receipt commit follows)
- **Count**: `17`

---

## Tasks

- **Completed**: `22 of 22` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

---

## Contract deviations

- **Marker `answer` data:** adds the optional `reason_wrapped?: true`.
  - **Recorded:** internal deviation, Task 3 fix round 1; `plan.md` Contracts updated.
  - **What it does:** `recordAnswer` writes it on new superseded verdicts, whose reason already wraps its forge text where the reason is built. Answers recorded before #20 lack the field, so their whole reason is wrapped at render.
  - **Why:** an applying legacy answer is never validated again, so its raw reason must still be wrapped once.
  - **Final fix wave:** made every reason producer wrap forge-derived parts, so the flag is truthful.
- **`commandAuthors`** gains an optional `skip: ReadonlySet<string>`. It is internal and backward compatible, and was added in the final fix wave so recorded `class` commands need no permission lookup. It was recorded in `plan.md` Contracts after verify W1.
- **`amendSubject`** now returns `Subject` instead of `string`. It is internal and only narrows the type (Task 3). It was recorded in `plan.md` Contracts after verify W1.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | sequential | `5528b42..f1daaed` | approved | n/a |
| 2 | sequential | `84f8d8f..0da651c` | approved | n/a |
| 3 | sequential | `ffe3c53..c691636` | approved after 1 fix round | n/a |
| 4 | sequential | `906252c..db59850` | approved after 1 fix round | n/a |
| 5 | sequential | `6ac8022..8f9cff2` | approved | n/a |
| 6 | sequential | `8f9cff2..811c941` | approved after 1 fix round | n/a |
| final fix wave | sequential | `5fb9126..52a71f4` | re-review clean | n/a |

Ticks of `tasks.md` and the Contracts note are separate `docs(openspec)` commits inside the range.

### Rulings

- **Lanes run sequentially in plan order.** Child worktrees need a ~5 min `node_modules` copy, and Task 2 was Easy. Cost if wrong: some wall-clock time only.
- **Task 6 (docs) was dispatched while the Task 5 review ran read-only.** There was one writer at a time. Cost if wrong: a delayed fix round.
- **Legacy answers keep their pre-#20 rendering.** A legacy answer is one with no `reason_wrapped`: its whole reason is wrapped once more. An old gate reason that already held a wrapper therefore shows escaped nested markup. This is safe: it never leaks raw forge text. It is pinned by "legacy wrapped reason stays escaped". Cost if wrong: a transient, cosmetic double-escaped reason, only for answers recorded before the upgrade that are still applying.

### Deferred minors (final review triage: not blocking)

- No test covers two `class` commands where the second marker write fails. `tests/interaction/poll.test.ts` covers the single-command case, and the behaviour follows the D2 known gap.

---

## Verification at receipt

- `bun run typecheck`: clean.
- `bun run test`: 114 files, 1639 tests passed (fix-wave implementer run at `52a71f4`). Re-review targeted runs: 155/155.
- `openspec validate sync-ls05-artifacts`: valid.
- `git diff --check 5528b42 HEAD`: clean.

---

## Next step

Run `/opsx-verify` in the worktree.
