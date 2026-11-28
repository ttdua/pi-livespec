# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `ledger-store`
**Iteration**: `1`
**Applied at**: `2026-11-28 15:45`
**Executor**: `subagent-driven-development` (superspec.implementer writer, superspec.task-reviewer read-only; parallel lanes for Tasks 2 and 3)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.ledger-store`
- **Worktree branch**: `ledger-store`
- **Feature branch**: `spec/ledger-store`
- **Base branch**: `main` (merged into the worktree branch at `a43d814`: origin/main `829d903` #78 interaction-contract, `c65ca6c` #74)

---

## Commits

- **Range**: `392d313..5ceea90` (this receipt is committed on top)
- **Count**: `52` (incl. 3 merge commits: two lane merges, one origin/main merge)

---

## Tasks

- **Completed**: `44 of 44` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none
- **Extra work outside tasks.md** (all reviewed):
  - perf pass (Task 9b): `0ecab88`, `3d9c82e` — one ref read per state read, SHA-keyed caches
  - origin/main merge and delta rebase: `a43d814`, `4a2522d` — main's new `gate-escalation` decision ported to the ledger; `phase-gates` delta added
  - final whole-branch review fix wave: `889db3b`..`82972d4`, `5ceea90` — retention keeps unsynced appends, fetch-before-use gaps closed, hostile content isolated, human decisions need their forge answer, alias/rebuttal convergence, guard refmap, packet ids, ship re-checks after sync, file-order ordering, ref collisions

---

## Validation

- `bun run typecheck`: clean
- `bun run test` (last full run, HEAD `5ceea90`, host load average ~58): 4306 passed, 2 failed — both `Test timed out in 30000ms`: `tests/e2e/initiative-flow.test.ts` "plan over the limits needs a split or a waiver" (passes alone, 4/4) and `tests/e2e/subagent-build.test.ts` "five units complete with dispatches and lanes" (30–38 s alone on this loaded host, also at the pre-fix commit `4a2522d`; passes with `--testTimeout=120000`). The previous full run at `4a2522d` passed 4289/4289.
- `openspec validate ledger-store --strict`: 0 errors (requirement-length warnings only)

---

## Contract deviations

- `MarkedComment` (internal): gains `source`, `createdAt?`, `from?` (Task 1) and `after?` (Task 10, so packet sources recompute `entryVersion`); plan.md Contracts updated.
- `SessionDeps.gitExec` (internal, Task 5): test seam for the session's git runner; production default `defaultGitExec`.
- `createForgeApprover` (internal, Task 5): takes the ledger as its 2nd parameter.
- `ApplyFn`/`ResultRecord` + exported `writeResult` helper (internal, Task 8).
- `assertEntry`, codec helpers, `ledgerRef`, `LedgerErrorCode` exports; `src/ledger/refs.ts`, `src/ledger/replay.ts` split (internal, Tasks 2 and 4).
- `RemoveResult.localKept`, `LedgerRead.unreadable`, `syncLedgerTip`, `deleteRefIf`, `src/ledger/alias.ts`, `src/decide/answered.ts` (internal, final fix wave).
- Record ids may not contain whitespace or `~` (internal, Task 2): existing id builders already satisfy this.
- No public contract changed beyond the approved shapes (`finding_rebut <ref>`, verifier `<aggregateRef>:<index>`, `ledger:<issue>/<ref>`, `ledger.retain`).

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | sequential | `392d313..492c588` | clean | — |
| 2 | `ledger-store--task-2` | `7fd1a91..7b779b0` | clean after 1 fix round | `a799680` |
| 3 | `ledger-store--task-3` | `7fd1a91..fc645c9` | clean | `c406f67` |
| 4 | sequential | `94138c2..ed69795` | clean after 1 fix round | — |
| 5 | sequential | `ec69595..1afdfad` | clean after 2 fix rounds | — |
| 6 | sequential | `a988042..43e5703` | clean after 1 fix round | — |
| 7 | sequential | `4e63fa8..10528ec` | clean | — |
| 8 | sequential | `f5ccd29..4b3891a` | clean | — |
| 9 | sequential | `62f7e57..14cadc1` | clean | — |
| 9b (perf) | sequential | `7902849..3d9c82e` | clean | — |
| 10 | sequential | `3d9c82e..e9e2bf8` | clean after 1 fix round | — |
| 11 | sequential | `39eacba..2dbae32` | clean | — |
| 12 | sequential | `eea5945..3c66afa` | clean | — |
| final review | sequential | `4a2522d..5ceea90` | final review REQUEST_CHANGES → fix wave → scoped re-review APPROVE | — |

---

## Next step

Run `/opsx-verify`. Known open items for verify: load-sensitive 30 s timeouts in the two e2e tests above; deferred minors (see the final scoped re-review): context hook leaves `fetchState` undefined so an advance waits a turn; a wildcard `git push` without `refs/livespec` gets the ledger reason; override/amendment-effect human records count without a forge answer (pre-existing).
