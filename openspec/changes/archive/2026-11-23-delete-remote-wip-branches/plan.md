# Delete Remote Wip Branches Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** `change_resume` deletes the remote `<Branch line>--wip-<unit>` branches of the `parked` record through a new guarded, lease-protected delete.

**Architecture:** `src/guard/push.ts` gains `guardedDeleteWip`. It does a read (`ls-remote`) and a delete (`push --force-with-lease … :refs/heads/<wip>`), and returns `deleted`, `gone` or `moved`. `change_resume` runs a new step between `mergeWips` and the label removal. That step rebuilds each branch name from the `Branch` line and the issue's unit ids, calls the delete, and refuses on a thrown `GitError` so a rerun completes the work.

**Tech Stack:** TypeScript (bun), vitest, git CLI through `GitExec`.

## Global Constraints

- The remote is always `origin`. The branch and head come only from the `parked` record, checked against `wipBranch(state.change.header.branch, unit)` and the issue's unit ids. Nothing comes from tool parameters.
- `guarded push module` importers: exactly `change-ship.ts`, `change-push.ts`, `fix-ship.ts`, `change-park.ts`, `change-resume.ts`.
- Untrusted text (git stderr, branch names from the forge) is wrapped in `untrusted(...)` in tool results, as the code already does.
- Verify: `bunx vitest run <file>`; full gate `bun run test` and `bun run typecheck`.

## Review Focus

1. Lease race: the branch moves between `ls-remote` and the push. The push is rejected as stale and the result is `moved`, not a refusal and not a deletion. Pinned in Task 1 ("stale lease is reported as moved").
2. A rerun after a partial delete: deleted branches read as `gone` and are not errors. Pinned in Task 2 ("Delete fails and rerun completes").
3. A tampered `parked` record whose branch is not `wipBranch(Branch, unit)` (for example `main`): it is kept, never deleted. Pinned in Task 2 ("Record entry that is not a wip branch of the change").
4. A unit with no branch in the record (no work at park): skipped silently, as `mergeWips` already does. Covered by the existing `wipBranches` filter; asserted in Task 2's two-lane test (only U2 and U3 deleted).
5. The delete step must never run when a wip merge conflicted: the refusal happens before it. Pinned in Task 2 ("wip conflict aborts and rerun skips merged" asserts both branches still on `origin` after the refused run).

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `guardedDeleteWip` | new | `(exec: GitExec, root: string, branch: string, head: string) => Promise<"deleted" \| "gone" \| "moved">`; throws `GitError` on a refused name (no git call) or an unclassified failure | no |
| `WipDeleteOutcome` | new | `type WipDeleteOutcome = "deleted" \| "gone" \| "moved"` exported from `src/guard/push.ts` | no |
| `ChangeResumeDetails` | modified | `{ merged?: string[]; deleted?: string[]; kept?: string[] }`; on success all three are set; `deleted` lists `deleted` and `gone` branches; `kept` lists `moved` and record-check failures | no |

---

## Task 1: Guarded wip-branch delete — implements 1

**Covers:** 1.1, 1.2
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/guard/push.ts`
- Test: `tests/guard/push-callers.test.ts`

**Interfaces:**
- Produces: `guardedDeleteWip`, `WipDeleteOutcome` (see Contracts).

- [ ] **Step 1: Write failing tests** in a new `describe("guardedDeleteWip")`, using `toolHarness()` (it has a bare `origin`) and `defaultGitExec`, with `B = "livespec/x--wip-U2"`, after `git push origin HEAD:refs/heads/B`:
  - `deletes at the recorded head`: returns `"deleted"`; `originRefs(h.origin)` no longer contains `refs/heads/B`.
  - `gone`: call it twice; the second call returns `"gone"`.
  - `moved`: push a new empty commit to `B`, then call with the old head; returns `"moved"`, and `B` is still on origin at the new sha.
  - `stale lease is reported as moved`: wrap `defaultGitExec` so that the first `ls-remote` returns the old head while the real ref has moved (push the new commit first, and make the fake exec answer the first `ls-remote` with `<old>\trefs/heads/B`). Returns `"moved"`, and the ref is kept.
  - `refuses a non-wip branch`: `livespec/x`, `main` and `-x--wip-U2` each reject with `GitError`, and a recording exec saw no call.
  - `ignores a suffix ref`: also push a different commit to the decoy `refs/heads/pre/refs/heads/B` (ls-remote lists it for pattern `refs/heads/B`); delete `B` at its head → `"deleted"`; a second call → `"gone"` (not `moved`), and the decoy is still on origin.
  - `unreachable remote throws`: `git remote set-url origin /nonexistent`; rejects with `GitError`.
  - `Delete of a wip branch` (spec scenario): with a recording exec, the only `push` call equals `["push", "--force-with-lease=refs/heads/B:<head>", "--", "origin", ":refs/heads/B"]`.
- [ ] **Step 2:** `bunx vitest run tests/guard/push-callers.test.ts` → FAIL (`guardedDeleteWip` is not exported).
- [ ] **Step 3: Implement `guardedDeleteWip`** in `src/guard/push.ts`:
  - `REMOTE = "origin"`.
  - Name check: the name must contain `--wip-` and must not start with `-`; otherwise throw `new GitError(["push", "--", "origin", `:refs/heads/${branch}`], null, "not a wip branch")`.
  - Read with `["ls-remote", "--exit-code", "--", "origin", "refs/heads/<b>"]`: code 2 → `gone`; code 0 → the sha of the line whose second field is exactly `refs/heads/<b>` (none → `gone`); any other code → throw `GitError`.
  - Remote sha ≠ head → `moved`. Otherwise push `["push", `--force-with-lease=refs/heads/<b>:<head>`, "--", "origin", `:refs/heads/<b>`]`; code 0 → `deleted`.
  - On a failed push, read again: `gone` → `gone`; another sha → `moved`; same sha or a failed read → throw the push's `GitError`.
  - Update the header comment: the delete, its single caller `change_resume`, and the spec reference.
- [ ] **Step 4:** `bunx vitest run tests/guard/push-callers.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(command-guards): guarded delete of a remote wip branch`.

---

## Task 2: Resume deletes remote wip branches — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5
**Difficulty:** Normal
**Blocked by:** Task 1

**Files:**
- Modify: `src/tools/change-resume.ts`
- Test: `tests/tools/change-resume.test.ts`, `tests/guard/push-callers.test.ts`, `tests/e2e/initiative-flow.test.ts`

**Interfaces:**
- Consumes: `guardedDeleteWip`, `WipDeleteOutcome` (Task 1); `wipBranch` from `src/deps/parked.ts`.
- Produces: `ChangeResumeDetails` (see Contracts).

- [ ] **Step 1: Update and write failing tests** in `tests/tools/change-resume.test.ts`:
  - `Resume with two lanes keeps all work`: replace the "Remote wip branches are kept" assertion. `details` becomes `{ merged: [wip("U2"), wip("U3")], deleted: [wip("U2"), wip("U3")], kept: [] }`, and `h.gitCalls.filter(a => a[0] === "push")` ends with exactly the two lease deletes `["push", `--force-with-lease=refs/heads/${wip(u)}:${head}`, "--", "origin", `:refs/heads/${wip(u)}`]` for U2 then U3.
  - `Remote wip branches deleted after resume`: `h.git("ls-remote", "origin", "refs/heads/" + wip(u))` is `""` for U2 and U3, and the text contains "Deleted remote" followed by both names.
  - `Wip branch already gone`: before resume, `h.git("push", "origin", ":refs/heads/" + wip("U2"))`. First assert `h.git("rev-parse", wip("U2"))` equals the recorded U2 head (park leaves local wip branches; `mergeRef` uses them). The resume succeeds, U2's work is merged, U3's branch is gone from origin, and `deleted` contains both. (A missing local and remote wip branch makes `mergeRef`'s fetch throw; this is existing behaviour and out of scope.)
  - `Wip branch moved since the park`: from `h.root`, without checkout: `c = h.git("commit-tree", "-p", u3Head, "-m", "moved", `${u3Head}^{tree}`)`, then `h.git("push", "origin", `${c}:refs/heads/${wip("U3")}`)` (the local wip branch stays at the recorded head). The resume succeeds, `kept` equals `[wip("U3")]`, origin still has U3 at the new sha, and the text contains `wip("U3")` and "head moved since the park".
  - `Delete fails and rerun completes`: run `h.git("remote", "set-url", "--push", "origin", "/nonexistent")` before resume, so sync's fetch and `ls-remote` still reach the real origin and only the delete push fails (`guardedDeleteWip` re-reads, sees the same head, throws). The resume refuses, the text names `wip("U2")` (the first unit), the label is still present and `parkedCore` is defined, and both branches are still on the real origin. Restore with `git remote set-url --delete --push origin /nonexistent` and rerun: success, `details.merged` is `[]`, and both branches are gone. (Fallback if this is flaky: the fixture's `h.rejectPush("U2")` / `h.allowPush` hook.)
  - `Record entry that is not a wip branch of the change` (spec scenario; was "tampered record branch is kept"): after the prerequisite merges and before resume, re-post the latest `parked` record's data with `h.seed("parked", "parked.<new id>", { ...original, units })`, where `units` keeps U3 unchanged and U2 keeps its real head but has `branch: "main"`. The resume succeeds; `details` is `{ merged: ["main", wip("U3")], deleted: [wip("U3")], kept: ["main"] }` (the merge step is unchanged: it merges the recorded U2 sha and reports the record's branch name `main`, design D2); origin `main` is unchanged; no push call names `main`.
  - `wip conflict aborts and rerun skips merged`: after the refused first run, assert both wip branches are still on origin; change the rerun's expected details from `{ merged: [] }` to `{ merged: [], deleted: [wip("U2"), wip("U3")], kept: [] }`.
- [ ] **Step 2:** In `tests/guard/push-callers.test.ts` "No tool calls the push path", add `"change-resume.ts"` to `allowed` and delete `expect(...).not.toContain("change-resume.ts")`. Add: among `sources` excluding `guard/push.ts`, the basenames whose text contains `guardedDeleteWip` equal `["change-resume.ts"]`, and `change-resume.ts` does not contain `guardedPush(`.
- [ ] **Step 3:** `bunx vitest run tests/tools/change-resume.test.ts` → FAIL.
- [ ] **Step 4: Implement in `src/tools/change-resume.ts`.**
  - `deleteWips(w, state, core): Promise<{ deleted: string[]; kept: string[] } | { refused: string }>` iterates over `wipBranches(core)`.
  - An entry whose `unit` is not in `state.change.units.map(u => u.id)`, whose `branch !== wipBranch(state.change.header.branch, unit)`, or whose `head` fails `/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/` goes to `kept` with reason "not a wip branch of this change", without a git call.
  - Otherwise call `guardedDeleteWip(w.session.exec, w.session.cwd, branch, head)`: `deleted`/`gone` go to `deleted`, `moved` goes to `kept` with reason "head moved since the park".
  - A `GitError` → `refused`: `deleting <untrusted(branch)> on origin failed (<untrusted(message)>); the change stays parked<, X are deleted>. Fix the cause and rerun change_resume.`
  - In `resume`, call it after `mergeWips` and before the label removal. On `refused`, run `afterForgeWrite` and refuse.
  - Text: append ` Deleted remote <list>.` when non-empty, and ` Kept on origin: <branch> (<reason>), ….` with a reason per branch; every branch name in the text is wrapped in `untrusted(...)`.
  - Set `details` per Contracts. Update the header comment and the tool description (drop "Never pushes"; say it deletes the remote wip branches).
- [ ] **Step 5:** `bunx vitest run tests/tools/change-resume.test.ts tests/guard/push-callers.test.ts` → PASS.
- [ ] **Step 6:** In `tests/e2e/initiative-flow.test.ts`, after `ok(await h.resume(), "change_resume")`, assert that `ls-remote` for `wip("U2")` and `wip("U3")` is `""`. `bunx vitest run tests/e2e/initiative-flow.test.ts` → PASS.
- [ ] **Step 7:** Full gate: `bun run test` and `bun run typecheck` → PASS.
- [ ] **Step 8: Commit** `feat(discovered-dependencies): change_resume deletes remote wip branches`.

---

## Task 3: Docs — implements 3

**Covers:** 3.1
**Difficulty:** Easy
**Blocked by:** Task 2

**Files:**
- Modify: `docs/architecture.md` (the "Resume" and "Known gap" paragraphs near line 375, the `guardedPush` paragraph near line 182)

- [ ] **Step 1:** In "Resume", after the wip merges, describe the new step: it deletes each wip branch on `origin` through the guarded delete with a lease on the recorded head; a branch already gone counts as deleted; a moved head or a record that is not this change's wip branch is kept and named; any other failure refuses and keeps the change parked, and a rerun completes it.
- [ ] **Step 2:** In the `guardedPush` paragraph, add that the module also holds `guardedDeleteWip`, called only by `change_resume`. Delete the "**Known gap.** Wip branches stay on the remote…" line.
- [ ] **Step 3:** `grep -n "removed by hand" docs/architecture.md` → no wip match.
- [ ] **Step 4: Commit** `docs(architecture): wip branches deleted on resume`.

---

## Scenario → test

- discovered-dependencies / Resume with two lanes keeps all work → `tests/tools/change-resume.test.ts` "Resume with two lanes keeps all work"
- discovered-dependencies / Remote wip branches deleted after resume → `change-resume.test.ts` "Remote wip branches deleted after resume"; `tests/e2e/initiative-flow.test.ts`
- discovered-dependencies / Wip branch already gone → `change-resume.test.ts` "Wip branch already gone"
- discovered-dependencies / Wip branch moved since the park → `change-resume.test.ts` "Wip branch moved since the park"
- discovered-dependencies / Record entry that is not a wip branch of the change → `change-resume.test.ts` "Record entry that is not a wip branch of the change"
- discovered-dependencies / Delete fails and rerun completes → `change-resume.test.ts` "Delete fails and rerun completes"
- discovered-dependencies / Prerequisite not merged → `change-resume.test.ts` "Prerequisite not merged" (unchanged)
- discovered-dependencies / Finished unit regresses → `change-resume.test.ts` "Finished unit regresses" (unchanged)
- command-guards / No tool calls the push path → `tests/guard/push-callers.test.ts` "No tool calls the push path"
- command-guards / Refspec from the issue → existing ship-phase test (unchanged)
- command-guards / Refspec from the fix branch → `push-callers.test.ts` "Refspec from the fix branch" (unchanged)
- command-guards / Refspec of a wip branch → `push-callers.test.ts` "Refspec of a wip branch" (unchanged)
- command-guards / Delete of a wip branch → `push-callers.test.ts` "guardedDeleteWip › Delete of a wip branch"
- command-guards / Delete refuses a non-wip branch → `push-callers.test.ts` "guardedDeleteWip › refuses a non-wip branch"
