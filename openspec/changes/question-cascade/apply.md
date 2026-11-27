# Apply Receipt

**Change**: `question-cascade`
**Iteration**: `1`
**Applied at**: `2026-11-27 10:34` (UTC)
**Executor**: `subagent-driven-development` (implementer `superspec.implementer`, task and final reviewer `superspec.task-reviewer`)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.question-cascade`
- **Worktree branch**: `question-cascade`
- **Feature branch**: `fix/question-cascade`
- **Base branch**: `main`

---

## Commits

- **Range**: `cade697..bdb9200` (the receipt commit follows `bdb9200`)
- **Count**: `19` before the receipt commit

---

## Tasks

- **Completed**: `19 of 19` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

---

## Contract deviations

All of these are internal contracts. No public contract changed shape.

- `selfGateComment` / plan gate record: the record type is named `RequirementRecord` and built by one helper `requirementRecord`, shared by `buildRequest` and `passSelf` (Task 3; one place for the computation).
- `integrationRef`: takes `Base` from the issue body just read instead of the session card, which can be stale after `change_sync` (Task 3). In the final fix wave it also takes the run's pinned HEAD sha, so the digests and the merge-base use the same commit.
- `excludedIds`: excludes only ids that are present at the integration reference (`reference[id]` defined). The controller ruled that an own removal must always cascade (Task 3 review). The spec and design were updated.
- `requirementDigests`: builds ids with the same whitespace collapse as `coversId` (Task 3, carried from the Task 1 review). It throws when two requirements of one capability normalize to the same id, instead of letting the last one win (final fix wave). Behaviour change, also for `change_sync`: a spec with duplicate normalized ids now fails the run with a recorded error, where it used to pick the last one silently.
- `gateRequest` / `buildRequest`: the plan requirement scope comes from the same issue body that `gate_digest` binds (final fix wave).
- `LockState.baseline` / `gateData`: `requirements` and `requirement_scope` are accepted only as a valid pair. Half a record, or a malformed one, falls back to the legacy path (final fix wave).
- `planSpecCascade`: `failedClosed(input)`: once an own `baseline.*` stale exists after the lock gate, nothing is compared until a new plan gate is approved, even if the commit becomes available again (final fix wave; matches the spec).
- `runSpecCascade`: pins the git branch and HEAD once per run and writes nothing unless the branch equals the change's `Branch` header. When the issue body has no `Branch` header, it compares against the branch the session card resolved on (final fix wave).
- `lockedEvidenceCall`: the positional `where` became an options object `{ where?, before? }`, as planned (Task 5).
- `readCascadeInput`: no comments-cache invalidation before the read, because `CachedForge.listComments` is not cached (`src/forge/cache.ts:181-183`). The cache is still invalidated after a write (Task 5).

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | sequential | `cade697..000c1ee` | Approved | n/a |
| 2 | sequential | `000c1ee..b0f46e8` | Approved | n/a |
| 3 | sequential | `b0f46e8..9e86da7` | Approved after fix round 1 | n/a |
| 4 | sequential | `9e86da7..019b2b8` | Approved | n/a |
| 5 | sequential | `019b2b8..da54eba` | Approved after fix round 1 | n/a |
| 6 | sequential | `da54eba..c31d26e` | Approved | n/a |
| final fix wave | sequential | `c31d26e..bdb9200` | Approved (scoped re-review) | n/a |

Final whole-branch review over `cade697..c31d26e`: With fixes, 6 Important. Four were fixed in the fix wave. Two were parked by controller ruling (see Rulings).

---

## Rulings

- Sequential lanes instead of parallel ones (one writer worktree). Cost if wrong: wall-clock time only.
- An id absent at the integration reference is never excluded. An integration-branch removal of a covered requirement therefore cascades once (fail-safe).
- Task 5: kept the crashed implementer's partial diff and verified it instead of redoing the work (user-approved option).
- Task 5: the interaction test imports the shared cascade fixture instead of keeping a duplicate copy.
- Final review FR2 (parked): an identical amendment followed by a re-lock lets a receipt from before the cascade re-tick a unit without rerunning `Verify`. This is pre-existing for every stale source (answers, `change_sync`) and outside #63. It is recorded in the design Risks; a follow-up issue is needed.
- Final review FR4 (parked): a partial cascade in a pack whose define phase has `gate: none` does not complete its move back. This affects custom packs only. The `stale` comment already invalidates later gate results, so later gates refuse. It is recorded in the design Risks.
- Final review FR6: malformed YAML frontmatter fails the run closed (nothing written, error recorded), the same way `change_sync` fails today. The design D1 wording was corrected.

---

## Validation

- `bun run typecheck`: exit 0.
- `bun run test`: exit 0, 255 files, 3981 tests passed (final fix wave run).
- Known pre-existing test isolation defect, out of scope: `tests/evidence/red-on-base.test.ts` ("Green on base refuses the plan gate") and `tests/evidence/worktree.test.ts` both assert that no `livespec-verify-*` directory exists in the shared OS tmpdir. They fail when run together or under host load, and pass alone (13/13 three times, 7/7 twice). They also fail at the base commit.

---

## Next step

Run `/opsx-verify`.
