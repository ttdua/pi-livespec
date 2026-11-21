# Verify Receipt

**Change**: `ship-and-close`
**Iteration**: `1`
**Verified at**: `2026-11-22`
**Worktree**: `/Users/naicoi/Projects/oss/pi-livespec.ship-and-close` (branch `ship-and-close`)
**Evidence**: parent run in this invocation, plus an independent `superspec.verifier` run over the same worktree (fresh commands, cited below)

## Overall Decision

**PASS_WITH_WARNINGS**: no CRITICAL issue. The fresh tests and typecheck are green, and every task is ticked. Every requirement and scenario has evidence. The warnings are the strict-mode requirement-length lint and partial contract coverage.

## Checks

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Structural validation | PASS with warning | `openspec validate ship-and-close` exited 0. `--strict` exited 1 with 0 errors and 12 warnings, all "Requirement text is very long (>500 characters)". The living specs show the same lint 81 times under `openspec validate --specs --strict`. |
| 2 | Task completion | PASS | `tasks.md` has 32 `[x]` and 0 `[ ]`. `openspec instructions apply` reports `{"total":32,"complete":32,"remaining":0}`. |
| 3 | Requirement evidence | PASS | Every ADDED or MODIFIED requirement maps to code (table below). No REMOVED or RENAMED requirements. |
| 4 | Scenario coverage | PASS | All 135 scenarios map to tests: 125 by exact name, 10 by a different test name (listed below). A fresh `bunx vitest run` passed. |
| 5 | Design and contract coherence | PASS with warning | The entries checked match the code or a recorded deviation. Some entries were not verified (listed below). |
| 6 | Clean tree | PASS | `git status --porcelain` was empty at HEAD `26b8cde`. The range is `0849377..26b8cde`, 44 commits, and includes the receipt-pin commit made after `apply.md` recorded `0f216d5`. |

## Fresh test run

All commands ran in `/Users/naicoi/Projects/oss/pi-livespec.ship-and-close`.

| Command | Exit | Result |
|---|---|---|
| `bunx vitest run` | 0 | 203/203 test files and 2929/2929 tests passed. The verifier ran it independently and got the same counts. |
| `bun run typecheck` (`tsc --noEmit`) | 0 | Clean |

## Check 3: requirement → implementation

- **change-close**
  - Pull request outcome: `src/ship/ship-steps.ts:16`, `src/engine/next-step.ts:303`
  - Close tool: `src/tools/change-close.ts:13,62-63`, `src/ship/close.ts:14`
  - Closed without merge: `src/tools/change-close.ts:26`
  - Close next steps: `src/ship/ship-steps.ts:60`
- **command-guards**
  - Guarded push: `src/tools/change-ship.ts:95`, `src/tools/change-push.ts:85`, `src/guard/push.ts:4`
- **finding-routing**
  - Finding scope rule: `src/review/route.ts:10-20`
  - Pull request review comments: `src/review/stages.ts:193`
- **flow-engine**
  - Change state from issue and git: `src/ship/pull-request.ts:21`
  - Next step precedence: `src/engine/next-step.ts:303-307`, `src/engine/gate-decision.ts:23`
  - Advance phase: `src/engine/advance.ts:35-50`
- **flow-pack**
  - Default flow pack: `src/packs/agent-skills.yaml:22,81-82`
  - Pack schema rules: `src/engine/pack-schema.ts:19`, `src/engine/pack-types.ts:6`
- **phase-gates**
  - Waivable checks: `src/ship/durable-register.ts:9`
  - Gate outcomes: `src/engine/gate-decision.ts:23`, `src/engine/locks.ts:68`
- **pull-request-feedback**
  - Feedback poll: `src/ship/feedback-poll.ts:112`, `src/hooks/session.ts:536`, `src/commands/next.ts:11`
  - Human voices: `src/ship/feedback.ts:80`, `src/ship/writers.ts`
  - Feedback findings: `src/ship/feedback.ts:80`
  - Feedback round: `src/ship/feedback-poll.ts`, `src/review/round.ts:107`
- **review-phase**
  - Review tool: `src/review/round.ts:107`, `src/review/stages.ts:142`
  - Review next steps: `src/review/next.ts`
- **ship-phase**
  - Change diff at ship: `src/ship/diff.ts:24`
  - Reviewed HEAD: `src/ship/reviewed.ts:10,37`
  - Durable docs output: `src/engine/next-step.ts:44`
  - Durable docs table tool: `src/tools/docs-table.ts:13`
  - Durable docs rule and check: `src/ship/durable-docs.ts:77`, `src/ship/durable-register.ts:9`
  - Ship tool: `src/tools/change-ship.ts:30,95`
  - Push tool: `src/tools/change-push.ts:25,85`
  - Ship tools in child sessions: `childRefusal` in `change-ship.ts:136`, `change-push.ts`, `change-close.ts:77`, `docs-table.ts:46`
  - Ship next steps: `src/ship/ship-steps.ts:16,44,60`

## Check 4: scenarios covered under a different test name

| Scenario | Test |
|---|---|
| Changed file outside every unit | `tests/review/route.test.ts:31` |
| Untouched file | `tests/review/route.test.ts:34` |
| Suggestion | `tests/review/route.test.ts:37` |
| Missed context outside the diff | `tests/review/route.test.ts:40` |
| Deleted test file stays in the change | `tests/review/route.test.ts:44` |
| Seeded defect routed to its unit | `tests/review/route.test.ts:28` |
| Clean merge while the integration branch moved | `tests/ship/reviewed.test.ts:49` |
| Closing keyword in the Proposal | `tests/ship/pr-body.test.ts:7-19` (case `["Closes #12", "Refs #12"]`) |
| No tool calls the push path | `tests/guard/push-callers.test.ts:24`, test named "Only change_ship and change_push call the push path" |
| Same pull request | `tests/e2e/ship-flow.test.ts:29` |

Pinned elsewhere: the short-SHA "unreviewed" refusal text is covered by `tests/tools/change-push.test.ts` ("Unreviewed commits refused") and `tests/ship/ship-steps.test.ts`. End to end, the refresh moves the change to `review` before that check runs; this was a ruling recorded during apply.

## Check 5: contracts and deviations

**Matched**
- Tools `docs_table`, `change_ship`, `change_push`, `change_close`: `src/tools/change-tools.ts:54-57`
- Events `livespec:change-closed` and `livespec:initiative-closed`: `src/tools/change-close.ts:62-63`
- `close-summary` marker: `src/ship/close.ts:14-17`
- `Git.mergeBase`, `mergeTree`, `treeOf`, `remoteRef`, `firstParentList`: `src/engine/git.ts:35-40`
- `changeDiff`, `filesOutsideUnits`: `src/ship/diff.ts`
- `isReviewed`: `src/ship/reviewed.ts`
- `reviewedHead`: narrowed to `lock`, as the deviation records
- `PhaseOutput` gains `issue#Durable docs`: `src/engine/pack-types.ts:6`
- `decisions.durable-docs`: `src/packs/agent-skills.yaml:22`
- `advancePhase` `merged` option: `src/engine/advance.ts:35-50`

**Deviations matched**
- `pullRequestBody` rewrite uses `$4`: `src/ship/pr-body.ts:6-10`
- `shipStale` → `shipStaleness` / `writerVoices(…, gateComment)`: `src/ship/freshness.ts:23,58`
- `staleShipId(staleness, gateCommentId)`: `src/ship/ship-refusals.ts:67`
- `source: pull-request` round kept at its head: `src/review/round.ts:107`
- Shared gate decision: `src/engine/gate-decision.ts`

**Design**
- D1–D3, D5–D11 are consistent with the code, per the verifier's file citations above.

**Not verified** (the verifier spot-checked, not traced)
- Exact shapes of `ShipContext`, `ChangeState.ship`, `CheckContext.ship/phase`, `CompletionCtx.shipFor`, `FeedbackItem`, `collectFeedback`, `pollFeedback`, `ReviewRunData.feedbackKeys` and `Session.exec`.
- Design D4 (freshness) and D12 (guard spec and docs), beyond locating their modules.
- None of these have failing tests.

## Issues

### CRITICAL
- None.

### WARNING
1. **Strict length lint.** `openspec validate ship-and-close --strict` exits 1 on 12 "requirement text >500 characters" warnings:
   - change-close: "Pull request outcome", "Close tool", "Closed without merge"
   - pull-request-feedback: "Feedback poll", "Feedback findings", "Feedback round"
   - ship-phase: "Reviewed HEAD", "Durable docs table tool", "Durable docs rule and check", "Ship tool", "Push tool", "Ship next steps"

   The same lint appears 81 times in the living specs, so it is an accepted project convention. Recommendation: before archive, split "Ship tool" and "Push tool" in `specs/ship-phase/spec.md` into refusal and effect requirements, or accept the lint at archive and record that.
2. **Partial contract coverage.** The internal contracts under "Not verified" were not traced field by field. Recommendation: during finalize's code review, compare `src/ship/context.ts` and `src/ship/feedback-poll.ts` with the plan.md Contracts rows, or accept them as internal.

### SUGGESTION
1. Rename `tests/guard/push-callers.test.ts:24` to the scenario name "No tool calls the push path", so scenario-to-test lookup works by name.
2. Rename `tests/ship/pr-body.test.ts:7` or add a test named "Closing keyword in the Proposal".
3. Update the `apply.md` range to `0849377..26b8cde` at finalize; it currently records the pre-pin receipt commit `0f216d5`.
