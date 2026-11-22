## Why

The small-fix lane calls a fix branch "nothing to ship" only when no commit follows the merge base. After a squash or rebase merge of the fix's pull request, the branch still counts as ahead, so the card says `fix_ship` and `fix_ship` opens a new, empty pull request. `change_new --from-fix` also moves empty or already-landed fixes into a new change. One shared notion of an empty fix closes both gaps (issue #37).

## What Changes

**Empty fix**
- From: a fix is empty only when no commit follows the merge base.
- To: a fix is also empty when merging HEAD into `origin/<integration>` would leave the integration tree unchanged (its content already landed, by any merge method, even after later integration commits). A conflicting merge is not empty.
- Reason: squash merges are the norm here; the commit count misses them.
- Impact: non-breaking; fewer bogus pull requests.

**Fix ship tool / Fix card**
- From: "nothing to ship" defined by commit count.
- To: "nothing to ship" whenever the fix is empty; the card's next step and the refusal message say the fix adds nothing to the integration branch.

**Move a fix into a change**
- From: `change_new <name> --from-fix` succeeds on an empty fix, creating a change issue with an empty Proposal and renaming the branch.
- To: it refuses with "nothing to move", creating no issue and renaming nothing.

## Capabilities

### New Capabilities

None.

### Modified Capabilities
- `small-fix-lane`: "Fix branch" defines an empty fix; "Fix ship tool", "Fix card" and "Move a fix into a change" use it (new scenarios for a squash-merged fix and "Nothing to move").

## Impact

- `src/fix/branch.ts`: `fixRange` also reports whether the fix is empty.
- `src/tools/fix-ship.ts`, `src/tools/change-new.ts`, `src/hooks/card-input.ts`, `src/hooks/phase-card.ts`: use the shared result; message wording.
- Tests under `tests/fix/`, `tests/tools/`, `tests/hooks/`.
- No new dependency, config key, tool parameter or schema change.
