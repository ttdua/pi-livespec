# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `subagent-dispatch`
**Iteration**: `2`
**Applied at**: `2026-11-20 19:58`
**Executor**: `subagent-driven-development`.
- **Implementer seat:** the `general-purpose` agent. Dispatches early in apply (Tasks 1–5 and 9) asked for `implementer`, but the executor in this session resolved that name to `general-purpose`; the transcripts show it. Later dispatches name `general-purpose` directly.
- **Review seats:** the `code-reviewer` agent did every task review, every re-review and the final whole-branch review.
- **Models and thinking:** no model override; thinking followed each task's `Difficulty`.

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.subagent-dispatch`
- **Worktree branch**: `subagent-dispatch`
- **Feature branch**: `ls-07`
- **Base branch**: `main`

---

## Commits

- **Range**: `4ad108f..dcc36fd`.
- **Iteration 2 range**: `faa9c14..dcc36fd`, 5 commits. They fix verify iteration 1 (FAIL):
  - `859153f` and `dcc36fd` fix F1 (CRITICAL). `mismatchOutcome` now waits, with a bound (`ABORT_SETTLE_MS` = 30 s), for the aborted child to settle before it posts the `launch-mismatch` record. A timeout is recorded in the evidence. A cancel during that wait records nothing.
  - `ea6a785` fixes F2. `unit_finish` refuses a dispatched unit whose stored packet cannot be read (`packet unavailable: <hash>`).
  - `9ba4c5a` and `5eaa536` add tests for the scenario "Missing location" (schema level and `subagent_record`, with a mutation check), type the test request, and make the lane-tool fixtures store real packets.
  - Review: the fix-iteration review found one new Important issue (a cancel during the settle wait still posted the record). `dcc36fd` fixed it, and the re-review is clean. The report holds exact RED/GREEN commands and output.
- **Iteration 1 range**: `4ad108f..bc16f9e`. It covers the lane merges, the `tasks.md` ticks, two user-decision artifact amendments (`0382005` lane tools, `34f5156` out-of-scope findings) and the final-review fix wave (`f2fce50..bc16f9e`, 15 commits). The `apply.md` commit itself comes after `bc16f9e`.
- **Count**: `72` (`4ad108f..dcc36fd`, including the iteration-1 apply and verify receipts)
- **Validation at `dcc36fd`** (iteration 2, implementer run): `bun run typecheck` clean; `bun run test`: 164 files, 2429 tests pass; `openspec validate subagent-dispatch`: valid.
- **Validation at `bc16f9e`** (reported by the fix-wave implementer, and checked by both re-review seats):
  - `bun run typecheck`: clean.
  - `bun run test`: 163 files, 2423 tests, 0 failures.
  - `openspec validate subagent-dispatch`: valid.
- **Baseline at `4ad108f`**: 136 files, 1988 tests.

---

## Tasks

- **Completed**: `41 of 41` checkboxes in tasks.md flipped to `- [x]`. Tasks 8.3 and 8.4 were added by the user-approved lane-tools amendment.
- **Remaining**: none

---

## Contract deviations

**Public, user-approved:**
- **Tools `lane_open` and `lane_merge` (new).** The plan gave `openLane` and `mergeLane` no caller. The user chose two parent tools, suggested by the build loop. Spec `parallel-lanes` gained "Lane tools"; the plan, tasks, design and proposal were amended (`0382005`).
- **`unit_finish` (modified).** It refuses while the unit has an open lane (ruling R10); spec `unit-evidence` "Unit finish tool" was amended. This keeps the "merge, then finish" invariant at the tool boundary.
- **`out-of-scope` findings never refuse `unit_finish` (spec `review-findings`, `34f5156`).** They are listed at the next human gate instead. User decision B1: the old rule deadlocked, because the default pack's first human gate is `ship`.

**Internal:**
- **`unfamiliarCode(phase, unit, specs, capabilities)`.** It takes the change's `Capabilities`, because shape, define and plan have no unit.
- **`unitRoot(state, unit, root)`.** It takes `root`, because `ChangeState` has no root field.
- **Records:**
  - `findingKey(commentId, index)` is the key for answered and shown sets.
  - `DispatchData` gains `reason`, `evidence`, `launchMismatch` (parent-only, `true` only) and `contextRequest`.
  - `FindingSummaryData` gains `contextRequest` and `system: "files-violation"` (parent-only).
  - Marker id suffixes: `.mismatch`, `.needs-context-<n>` and `.system.files-violation.<n>`.
- **Lane record.** It gains optional `outcome` and `head`. `ChangeState.subagents` gains `laneHeads`, `mergedLaneHeads`, `laneLimit` and `unfamiliar`.
- **`DispatchDeps.abortSettleMs`** (iteration 2). It is optional, so tests can inject a short abort-settle timeout. The default is `ABORT_SETTLE_MS` = 30 s.
- **`GateSnapshot.findings`.** It is optional. Gate comments record the finding keys their payload showed (ruling R5).
- **New modules not in plan.md:**
  - `run-record.ts`, `subagent-target.ts`, `subagent-request.ts`, `subagent-outcome.ts`;
  - `lane-ops.ts`, `packet-store.ts`, `finish-gate.ts`, `finish-freshness.ts`;
  - `build-loop.ts`, `payload.ts`, `card.ts`, `unfamiliar.ts`, `phase-entries.ts`, `validate.ts`, `flow.ts`, `spill.ts`.
- **Packets and freshness:**
  - `roleSkillPaths(..., subject?)` returns `{ ok, paths, names }`.
  - `PacketContext.session` is `{ activeTree? }`, with an optional `finding`.
  - `Packet.seen` exists.
  - `checkFreshness(packet, current, ownAgent?)` is used with `readCurrent(...)`.
- **Dispatch and lanes:**
  - Dispatch outcome `cancelled`; `DispatchDeps.signal`.
  - `mergeLane` takes checks and has an `aborted` outcome.
  - `lockedEvidenceCall` takes `where`.
  - New helpers: `unitInvariantRefusal`, `laneOpenRefusal`, `tickBlocking`, `answeredFindingKeys`, `gatesShownKeys`, `unshownSystemFindings`.
  - `roles.checkSchema` exists.
- **Lane worktrees.** `.worktrees/` is added idempotently to `<git-common-dir>/info/exclude`.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | `subagent-dispatch--task-1` | `4ad108f..0f4fca5` | clean after fix round 1 | `bbb76c6` |
| 2 | `subagent-dispatch--task-2` | `4ad108f..c65d641` | clean after fix round 1 | `7794b14` |
| 3 | `subagent-dispatch--task-3` | `4ad108f..fb251bc` | clean after fix round 1. The implementer committed on `ls-07` first; the controller cherry-picked the commit and reset `ls-07`. | `f265295` |
| 4 | `sequential` | `1aa210b..3861f31` | clean after fix round 3 | — |
| 5 | `subagent-dispatch--task-5` | `ebba5fc..b62cac5` | clean after fix round 2 | `7163bd9` |
| 6 | `sequential` | `cdef1d5..55e1d6b` | clean after fix round 3 | — |
| 7 | `subagent-dispatch--task-7` | `3cb6dda..2e3d1eb` | clean after fix round 1 | `4837870` |
| 8 | `sequential` | `0382005..a133cfd` | clean after fix round 3. Amended after NEEDS_CONTEXT, by user decision. | — |
| 9 | `subagent-dispatch--task-9` | `ebba5fc..c4bb574` | clean after fix round 2; 1 minor deferred | `3107024` |
| 10 | `sequential` | `4c54029..9e797e1` | clean after fix round 1. The first attempt was lost to a network error. | — |
| Fix iteration 2 | `sequential` | `faa9c14..dcc36fd` | 1 new Important found and fixed; re-review clean | — |
| Final review | `sequential` | `34f5156..bc16f9e` | 3 seats (A, B, C): 1 Critical and 8 Important. One fix wave fixed them; both re-review seats found it clean. | — |

---

## Next step

Run `/opsx-verify` (iteration 2). Verify iteration 1 also left 14 items not verified, because the verifier ran out of budget; re-check them. Parked items, each with its ruling, for verify and finalize to consider:
- `lane_merge` on a missing worktree deletes the lane branch.
- After a gate result, re-gated phases no longer suggest the advisory reviewer.
- If `subagent_answer` is cancelled after `ANSWERED`, no result is recorded.
- README role guidance still mentions a model for the reserved `verifier` role.
- The `forge_read` hash test changes a different item.
- Several cosmetic minors from the review reports.
