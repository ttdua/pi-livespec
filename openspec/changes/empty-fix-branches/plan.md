# Empty Fix Branches Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** One shared "empty fix" result (no commit after the merge base, or content already landed on `origin/<integration>`) drives the fix card, `fix_ship` and `change_new --from-fix`.

**Architecture:** `fixRange` in `src/fix/branch.ts` gains an `empty` flag computed right after its fetch with `Git.mergeTree`/`treeOf`/`remoteRef` (design D1, D2). The three callers read the flag instead of `subjects.length === 0`, and share one reason phrase (D3).

**Tech Stack:** TypeScript, Bun, Vitest, git CLI (`merge-tree --write-tree`, git ≥ 2.38 with a fallback).

## Global Constraints

- No new dependency, config key, tool parameter or `Git` interface method.
- Refusals change nothing: no push, no pull request, no issue, no branch rename.
- Repo text in messages stays wrapped by `untrusted(...)` where callers already do so.
- Code, comments and messages in English.

## Review Focus

- A fix that lands, then the integration branch moves on: must still be empty (not tree equality only).
- A fix conflicting with the integration branch: must not be empty, and must not throw.
- `merge-tree` unsupported (old git): fall back to tree equality, never throw.
- `origin/<integration>` ref absent after a successful fetch, or an unexpected `mergeTree` git error: treat as not landed rather than throw — covered by fake-`Git` tests in Task 1.
- `change_new --from-fix` on an empty fix does no pull request lookup and no write before refusing — asserted by "no issue" + branch unchanged.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `fixRange` (`src/fix/branch.ts`) | modified | `(git: Git, integration: string) => Promise<{ mergeBase: string; subjects: string[]; empty: boolean }>`; throws on fetch/merge-base/git failure as today | no (internal module API) |
| `fixEmptyReason` (`src/fix/branch.ts`) | new | `(branch: string, integration: string) => string` returning `` `${branch} adds nothing to origin/${integration} (no commit after the merge base, or its changes are already there)` `` | no |
| `fix_ship` refusal 3 text | modified | `` `there is nothing to ship: ${fixEmptyReason(branch, integration)}; switch back to ${integration}.` `` | yes (tool output) |
| `change_new --from-fix` refusal text | new | `` `there is nothing to move: ${fixEmptyReason(branch, integration)}; switch back to ${integration}.` `` | yes (tool output) |
| `fixNextStep` empty text (`src/hooks/phase-card.ts`) | modified | `` `Nothing to ship on ${branch}: it adds nothing to the integration branch. Switch back to the integration branch.` `` | yes (card text) |

---

## Task 1: Shared empty-fix check — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/fix/branch.ts`
- Test: `tests/fix/branch.test.ts`

**Interfaces:**
- Consumes: `Git.fetch`, `Git.mergeBase`, `Git.subjects`, `Git.remoteRef`, `Git.mergeTree`, `Git.treeOf` (`src/engine/git.ts`).
- Produces: `fixRange` and `fixEmptyReason` per Contracts.

- [ ] **Step 1: Write failing tests.** First update the existing `toEqual` at `tests/fix/branch.test.ts:52` to `{ mergeBase: base, subjects: ["first", "second"], empty: false }`. Then in `tests/fix/branch.test.ts`, `describe("fixRange empty")`, using `fixture`/`upstreamCommit`/`sh` from `tests/ship/repo.ts` (HEAD is branch `feature` in `f.work`):
  - "no commit is empty": `expect((await fixRange(f.git, "main")).empty).toBe(true)`.
  - "real fix is not empty": commit `a.ts` in `f.work`; `empty` is `false`, `subjects` is `["fix a"]`.
  - "Squash-merged fix is empty": commit `a.ts` ("a\n") in `f.work`; in `f.upstream` write the same `a.ts` content, commit, push to `main`; then `upstreamCommit(f, "later.ts")`; `fixRange` → `subjects.length === 1` and `empty === true`.
  - "Rebase-merged fix is empty": two commits in `f.work` (`a.ts`, `b.ts`); in `f.upstream` `upstreamCommit` the same two files with the same contents (new commits, different SHAs); `fixRange` → `subjects.length === 2`, `empty === true`.
  - "Conflicting fix is not empty": in `f.work` change `README.md` to `"mine\n"` and commit; `upstreamCommit(f, "README.md", "theirs\n")`; `empty === false`, no throw.
  - "unsupported merge-tree falls back to tree equality": wrap `f.git` as `{ ...f.git, mergeTree: async () => "unsupported" as const }`; squash-merged without the later commit → `empty === true`; with the later upstream commit → `empty === false`.
  - "missing tip or merge-tree failure is not empty": with a real fix commit, `{ ...f.git, remoteRef: async () => undefined }` → `empty === false`; `{ ...f.git, mergeTree: async () => { throw new Error("boom"); } }` → `empty === false`, no throw.
  - `fixEmptyReason("fix/typo", "main")` equals the Contracts string.
- [ ] **Step 2: Run** `bun run test tests/fix/branch.test.ts` — expect FAIL (`empty` undefined / `fixEmptyReason` not exported).
- [ ] **Step 3: Implement** in `src/fix/branch.ts`: `fixEmptyReason`; a private `landed(git, integration): Promise<boolean>` — `tip = await git.remoteRef(\`origin/${integration}\`)`; `undefined` → `false`; `r = await git.mergeTree(tip, "HEAD")`; `"conflict"` → `false`; `"unsupported"` → `(await git.treeOf("HEAD")) === (await git.treeOf(tip))`; else `r.tree === (await git.treeOf(tip))`. A throw from `mergeTree` is caught and returns `false` (never a false "empty"; design D2); fetch/merge-base/subjects failures still throw. `fixRange` returns `empty: subjects.length === 0 || (await landed(git, integration))` (call `landed` only when subjects is non-empty). Update the doc comments.
- [ ] **Step 4: Run** `bun run test tests/fix/branch.test.ts` and `bun run typecheck` — expect PASS (callers still compile: the new field is additive).
- [ ] **Step 5: Commit** `feat(small-fix-lane): detect fixes whose changes already landed`.

---

## Task 2: Callers use the shared check — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5
**Difficulty:** Normal
**Blocked by:** Task 1

**Files:**
- Modify: `src/tools/fix-ship.ts`, `src/tools/change-new.ts`, `src/hooks/card-input.ts`, `src/hooks/phase-card.ts`
- Test: `tests/tools/helpers.ts`, `tests/tools/fix-ship.test.ts`, `tests/tools/change-new.test.ts`, `tests/hooks/card-input.test.ts`, `tests/hooks/phase-card.test.ts`

**Interfaces:**
- Consumes: `fixRange` (with `empty`), `fixEmptyReason` from Task 1.
- Produces: the user-facing texts in Contracts.

Test helper `squashOntoMain(h: ToolHarness, branch: string): void` in `tests/tools/helpers.ts` (used by three test files) simulates a squash merge: `h.git("switch", "-q", "main")`, `h.git("checkout", branch, "--", ".")`, `h.git("commit", "-q", "-m", "Squash")`, `h.git("push", "-q", "origin", "main")`, `h.git("switch", "-q", branch)`. The fix commit is then not an ancestor of `origin/main`, but its content is.

- [ ] **Step 1: Write failing tests**
  - `tests/tools/fix-ship.test.ts` "Squash-merged fix not shipped": `fixReady()`, squash onto `main`, then one more `main` commit pushed to origin (switch to `main`, write `later.md`, commit, push, switch back) so the tree-equality fallback alone would not pass, `await refusedUnchanged(h, "nothing to ship")`, `expect(await openPulls(h)).toHaveLength(0)`. Existing "Nothing to ship" stays.
  - `tests/tools/change-new.test.ts` "Nothing to move" (two cases): (a) `toolHarness({ config: CONFIG, branch: "fix/retry" })` with no commit; (b) `forcedFix()` then squash onto `main`. Each: `out.isError === true`, text contains `"nothing to move"`, `await noIssue(h)`, `h.git("branch", "--show-current") === "fix/retry"`, `h.git("branch", "--list", "livespec/retry-budget") === ""`.
  - `tests/hooks/card-input.test.ts` "Squash-merged fix card": `onFix()`, squash onto `main`, `refresh`, `expect(fixInput(h)).toEqual(expect.objectContaining({ slug: "typo", empty: true }))`; `renderCard` text contains `Nothing to ship on fix/typo` and neither `fix_ship` nor `change_new`.
  - `tests/hooks/phase-card.test.ts` "Empty fix card": expected next line becomes the Contracts `fixNextStep` text; card contains neither `fix_ship` nor `change_new`.
- [ ] **Step 2: Run** those four files — expect the new tests and the updated wording to FAIL.
- [ ] **Step 3: Implement**
  - `src/tools/fix-ship.ts` `fixRange`: destructure `empty`; `if (empty) return { refused: \`there is nothing to ship: ${fixEmptyReason(f.branch, integration)}; switch back to ${integration}.\` }`; update the refusal-3 comment.
  - `src/tools/change-new.ts` `fromFixRefusal`: after the `try` around `fixRange`, before `listPullRequests`: `if (found.empty) return { refused: \`there is nothing to move: ${fixEmptyReason(branch, integration)}; switch back to ${integration}.\` }`. Keep `branch` wrapping consistent with the existing refusals in that function.
  - `src/hooks/card-input.ts` `buildFixCard`: `const { mergeBase, empty } = await fixRange(...)`; `if (empty) return { slug, empty: true }`.
  - `src/hooks/phase-card.ts` `fixNextStep`: Contracts text; adjust the `FixCard` comment if needed.
- [ ] **Step 4: Run** `bun run typecheck && bun run test` — expect PASS (whole suite; `spec-status`, `guard` tests read the same `empty` flag).
- [ ] **Step 5: Commit** `fix(small-fix-lane): treat empty or landed fixes as nothing to ship or move`.

---

## Scenario → test

- Hand-made fix branch → `tests/fix/branch.test.ts` "Hand-made fix branch" (existing)
- Not a fix branch → `tests/fix/branch.test.ts` "Not a fix branch" (existing)
- Squash-merged fix is empty → `tests/fix/branch.test.ts` "Squash-merged fix is empty" (Task 1)
- Rebase-merged fix is empty → `tests/fix/branch.test.ts` "Rebase-merged fix is empty" (Task 1)
- Conflicting fix is not empty → `tests/fix/branch.test.ts` "Conflicting fix is not empty" (Task 1)
- Ship a small fix → `tests/tools/fix-ship.test.ts` "Ship a small fix" (existing)
- Forced fix refused → `tests/tools/fix-ship.test.ts` existing forced test
- Failing tests → `tests/tools/fix-ship.test.ts` existing
- No test command → `tests/tools/fix-ship.test.ts` existing
- Nothing to ship → `tests/tools/fix-ship.test.ts` "Nothing to ship" (existing)
- Squash-merged fix not shipped → `tests/tools/fix-ship.test.ts` "Squash-merged fix not shipped" (Task 2)
- Foreign pull request → `tests/tools/fix-ship.test.ts` "Foreign pull request" (existing)
- Rerun updates the pull request → `tests/tools/fix-ship.test.ts` existing rerun test
- Small fix card → `tests/hooks/phase-card.test.ts` "Small fix card" (existing)
- Forced fix card → `tests/hooks/phase-card.test.ts` "Forced fix card" (existing)
- Empty fix card → `tests/hooks/phase-card.test.ts` "Empty fix card" (updated, Task 2) and `tests/hooks/card-input.test.ts` "no commit after the merge base is empty" (existing)
- Squash-merged fix card → `tests/hooks/card-input.test.ts` "Squash-merged fix card" (Task 2)
- No dispatch → `tests/hooks/phase-card.test.ts` "No dispatch" (existing)
- Forced fix keeps its commits → `tests/tools/change-new.test.ts` "Forced fix keeps its commits" (existing)
- Open fix pull request → `tests/tools/change-new.test.ts` "Open fix pull request" (existing)
- Not on a fix branch → `tests/tools/change-new.test.ts` "Not on a fix branch" (existing)
- Nothing to move → `tests/tools/change-new.test.ts` "Nothing to move" (Task 2, both cases)
