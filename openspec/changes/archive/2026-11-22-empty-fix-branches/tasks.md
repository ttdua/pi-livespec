## 1. Shared empty-fix check

Blocked by: none

- [x] 1.1 `fixRange` in `src/fix/branch.ts` returns `empty`: no commit after the merge base, or `mergeTree(origin/<integration>, HEAD)` equals the tree of `origin/<integration>`; conflict is not empty; `unsupported` falls back to HEAD tree equals the integration tree (design D1, D2)
- [x] 1.2 Export the shared reason phrase `fixEmptyReason(branch, integration)` (design D3)
- [x] 1.3 Tests in `tests/fix/branch.test.ts`: no commit, squash-merged then a later upstream commit, rebase-merged two-commit fix, conflicting fix, real fix, `unsupported` fallback via a fake `Git`

## 2. Callers use the shared check

Blocked by: 1

- [x] 2.1 `fix_ship` refusal 3 uses `empty` and the shared phrase (`src/tools/fix-ship.ts`)
- [x] 2.2 `change_new --from-fix` refuses with "nothing to move" when `empty`, before the open pull request lookup, creating no issue and renaming nothing (`src/tools/change-new.ts`)
- [x] 2.3 The fix card sets `empty: true` from `fixRange().empty`; the card next step wording says the fix adds nothing to the integration branch (`src/hooks/card-input.ts`, `src/hooks/phase-card.ts`)
- [x] 2.4 Tests: `tests/tools/fix-ship.test.ts` (Squash-merged fix not shipped), `tests/tools/change-new.test.ts` (Nothing to move: empty and squash-merged), `tests/hooks/card-input.test.ts` (Squash-merged fix card), `tests/hooks/phase-card.test.ts` (Empty fix card wording)
- [x] 2.5 `bun run typecheck` and `bun run test` pass
