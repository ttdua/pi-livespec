## 1. Forge, git and state ports

Blocked by: none

- [x] 1.1 Add `id` and `updatedAt` to `ReviewComment` and `Review`, and `author` to `PullRequest`, in `src/forge/types.ts`; map them in `src/forge/github.ts` and `src/forge/gitea.ts`; extend `tests/forge/contract.ts`, the memory forge, `tests/forge/fake-gh/` and `tests/forge/fake-gitea.ts`
- [x] 1.2 Add `mergeBase`, `mergeTree` (`git merge-tree --write-tree`: tree, `conflict` or `unsupported`), `treeOf`, `remoteRef` and `firstParentList` to `Git` in `src/engine/git.ts`, with tests on a real temporary repo
- [x] 1.3 Add `headSha`, `request` and `commentId` to `GateResult` in `src/engine/locks.ts`, read from the `gate` comment, and `state` to `ChangeState.issue` (defaulted in `tests/helpers/change-state.ts`)
- [x] 1.4 Add `exec: GitExec` to `Session` (the exec `createGit` receives) and pass the harness's recording exec in `tests/tools/helpers.ts`; add an `events` spy to `tests/hooks/fake-pi.ts`
- [x] 1.5 Extract `staleComment(id, { reason, phases })` to `src/interaction/stale.ts` and refactor `complete-gate.ts` onto it (no behavior change)

## 2. Ship core (pure)

Blocked by: 1

- [x] 2.1 `src/ship/diff.ts`: the change diff and `filesOutsideUnits` (ship-phase "Change diff at ship"; the Files part of "Ship tool")
- [x] 2.2 `src/ship/reviewed.ts`: `reviewedHead(state)` and `isReviewed` over the first-parent chain with the clean-merge exception (ship-phase "Reviewed HEAD")
- [x] 2.3 `src/ship/records.ts`: marker kind `ship` and `latestShipRecord`
- [x] 2.4 `src/ship/pr-body.ts`: title and body with `Refs #<change>` and the closing-keyword rewrite
- [x] 2.5 `src/ship/freshness.ts`: `humanThreadComments` with timestamps and the ship freshness check (ship-phase "Ship tool" freshness bullet)

## 3. Durable docs

Blocked by: 2

- [x] 3.1 Output `issue#Durable docs` in `PhaseOutput`, the pack schema's `OUTPUTS` and `missingOutputSentence` (naming `docs_table`), with the presence rule (ship-phase "Durable docs output")
- [x] 3.2 `src/ship/durable-docs.ts`: the `durable-docs` rule and schema, `durableFacts`, the check (errors `error`, confirmation items `warning`), and the ship payload section "Needs your confirmation"
- [x] 3.3 `src/ship/context.ts`: the per-refresh `shipContext` memo (one fetch, change diff, durable facts); `CheckContext.ship` filled by the check runner; `card-input.ts` fills `ChangeState.ship.docsRowsNeeded`
- [x] 3.4 `src/ship/docs-table.ts` and tool `docs_table` (ship-phase "Durable docs table tool"); refuses in a child session
- [x] 3.5 Default pack and its fixture: `ship` output and check, `decisions.durable-docs` (flow-pack deltas)

## 4. Pull request state and advance

Blocked by: 2

- [x] 4.1 Snapshot `pr` from `PR:` and `pushedHead` from `refs/remotes/origin/<branch>`; unreadable pull request → absent plus warning (flow-engine "Change state from issue and git")
- [x] 4.2 `planMove` / `advancePhase` `merged` option; the session's derived advance passes `state.pr.merged` (flow-engine "Advance phase")

## 5. Next steps for ship and close

Blocked by: 3, 4

- [x] 5.1 `shipContext` gains `reviewed`, `needsShipGate` and `gatesAtHead` (recomputed every refresh); `card-input.ts` fills the optional `ChangeState.ship` fields
- [x] 5.2 Head-bound gates: in `review` and `ship`, an approved gate result whose `headSha` HEAD is not reviewed against counts as superseded, for the sentence and the waivers (flow-engine "Next step precedence")
- [x] 5.3 `src/ship/ship-steps.ts`: the pull request outcome rule (precedence 2), the ship steps (with the gate decision when re-confirmation is needed) and the close steps; wire them into `RULES`; the approved ship gate sentence says "run `change_ship`" (flow-engine, phase-gates, ship-phase "Ship next steps", change-close "Pull request outcome", "Close next steps")

## 6. Ship tool

Blocked by: 5

- [x] 6.1 `src/tools/change-ship.ts`: refusals, the stale write, adoption, `guardedPush`, `createPullRequest`, `PR:` write and `ship` record, all under the evidence lock (ship-phase "Ship tool")
- [x] 6.2 Register it; child-session refusal; update `src/guard/push.ts`'s comment and `tests/guard/push-callers.test.ts` (command-guards "Guarded push")

## 7. Push tool

Blocked by: 6

- [x] 7.1 `src/tools/change-push.ts` with an injected `ShipPoll` (no-op until group 9): refusals, re-confirmation, `guardedPush`, `ship` record (ship-phase "Push tool"); child-session refusal

## 8. Review changes for feedback rounds

Blocked by: 1

- [x] 8.1 `ReviewRunData` gains `source` and `feedbackKeys`; `round.ts` never replaces a `pull-request` run on a new HEAD and runs its later stages at its head; `effects.ts` skips pull request comments for it (review-phase "Review tool", finding-routing "Pull request review comments")
- [x] 8.2 `routeFinding` routes a `check:<name>` location `in-change`; `review/next.ts` names the failing check (finding-routing "Finding scope rule", review-phase "Review next steps")

## 9. Feedback mapping and poll

Blocked by: 4, 7, 8

- [x] 9.1 `src/ship/feedback.ts`: human voices with the permission check, mapping, keys and the ingest-once filter (pull-request-feedback "Human voices", "Feedback findings")
- [x] 9.2 `src/ship/feedback-poll.ts`: single-flight poll posting the `review-run`, the `stale` comment and the move to `review`; called after `pollApprovals` at `session_start` and in `/livespec next`; `change_push`'s default poll (pull-request-feedback "Feedback poll", "Feedback round")

## 10. Close

Blocked by: 5, 6, 7

- [x] 10.1 `src/ship/close.ts`: marker kind `close-summary`, summary, initiative tick and close, issue close and events, each step idempotent (change-close "Close tool")
- [x] 10.2 `src/tools/change-close.ts` with `--abandon <reason>`; child-session refusal (change-close "Closed without merge")

## 11. End-to-end flow and docs

Blocked by: 9, 10

- [ ] 11.1 `tests/e2e/ship-flow.test.ts` covering issue #32 "Done when"
- [ ] 11.2 `docs/architecture.md` (Ship, Pull request feedback, Close, tool list) and `docs/glossary.md` ("Reviewed SHA", integration branch)
- [ ] 11.3 `bun run typecheck` and `bun run test` pass
