## MODIFIED Requirements

### Requirement: Change state from issue and git
The engine SHALL build `changeState` only from the change issue, the pull request its `PR` line names, and git:
- from the issue: the phase label, the parsed body, own marked comments, unit status lines and Questions;
- from the pull request: its number, its state, whether it is merged and when;
- from git: the current branch, HEAD, a clean or dirty tree, the diff of `specs/` from `Base` to HEAD, and the pushed head `refs/remotes/origin/<branch>` when it exists.

From own marked comments it SHALL derive pending approver requests, gate results, the unit lock with frozen and stale units, stale phases, an unanswered stuck report, the `change_iterations` state, started units, receipts, unit attempts, blocked units, receipted units that are not yet ticked, and the items of the latest `incomplete` comment. It MUST NOT use session memory as a source of state. When the forge is in read-only mode, the state MUST be built from cached data and marked stale. A `PR` line whose pull request cannot be read SHALL leave the pull request state absent and add a warning naming it.

#### Scenario: State from fixture issue
- **WHEN** the snapshot is read for an issue with label `livespec:phase/build`, unit U1 done and U3 pending, and a dirty tree
- **THEN** `changeState` has phase `build`, U1 done, U3 pending, and `dirty: true`

#### Scenario: Stale state
- **WHEN** the forge is unreachable and the issue is cached
- **THEN** `changeState` is built from the cache and marked stale

#### Scenario: Ambiguous phase
- **WHEN** the issue carries two `livespec:phase/*` labels
- **THEN** `changeState` reports `phase-ambiguous` with both phases

#### Scenario: Pending request and lock from comments
- **WHEN** the issue has an own approved plan `gate` comment locking U1 and U2, U2's body differs from its locked digest, and an own `request` comment for `question:Q4` has no answer
- **THEN** `changeState` shows U2 frozen and a pending request for `question:Q4`

#### Scenario: Started unit from comments
- **WHEN** the issue has an own `unit-start` comment for U2 and no later `receipt` for U2, and U2 is pending
- **THEN** `changeState` shows U2 started

#### Scenario: Done unit is never started
- **WHEN** U2 has an own `unit-start` comment and no receipt, and a human ticked U2 on the web
- **THEN** `changeState` does not show U2 started

#### Scenario: Pull request state
- **WHEN** the issue has `PR: #41` and pull request 41 is merged
- **THEN** `changeState` holds pull request 41 as merged, with its merge time

#### Scenario: Unreadable pull request
- **WHEN** the issue has `PR: #41` and reading pull request 41 fails
- **THEN** `changeState` holds no pull request state and a warning names #41

### Requirement: Next step precedence
`nextStep` SHALL only be called with a valid pack; the caller reports pack errors instead (see flow-pack). The next-step sentence MUST follow this precedence:
1. missing or ambiguous phase label;
2. outside the last phase and while the change issue is open, a `PR` line whose pull request is merged or closed without merge: the steps of change-close "Pull request outcome";
3. change not started after `shape`;
4. unanswered stuck report;
5. pending blocking approver request, or an answered request whose effects are not yet fully applied;
6. the `change_iterations` cap blocking, as questions-and-stuck "Iteration cap" defines it;
7. open blocking question;
8. frozen or stale units, while a lock exists and the phase is at or after the phase that outputs `issue#Units`;
9. missing phase output;
10. failing check not waived by the phase's valid gate result;
11. in a `per: unit` phase, a blocked unit: send a stuck report with `spec_stuck`;
12. in a `per: unit` phase, a started unit: finish it with `unit_finish`;
13. in a `per: unit` phase, a receipted unit that is not ticked: run `unit_finish` again;
14. in `build`, the next pending unit whose `Depends` are done, or the units waiting on `Depends` when none is ready;
15. in `review`, the review steps of review-phase "Review next steps";
16. in `ship`, the steps of ship-phase "Ship next steps", and in `close`, the steps of change-close "Close next steps";
17. the phase gate.

At the gate, the sentence MUST reflect the valid gate result for the phase, meaning the latest own result newer than the latest `stale` comment listing the phase. A superseded latest result counts as no valid result and never falls back to an older one. In `review` and `ship`, an approved result SHALL count as superseded, for the sentence and for its waivers, when HEAD is not reviewed against its `head_sha` in the sense of ship-phase "Reviewed HEAD" (equal, or only clean integration merges after it), so the gate is requested again at the new HEAD. An approved valid result MUST report the successor as `advance`, except at `ship`. The sentence covers:
- `changes_requested`: revise and request again;
- `dismissed`: ask the human how to proceed;
- superseded: request again;
- an approved `ship` gate with no pull request: run `change_ship`.

In the last phase of the flow, once no earlier rule applies, the sentence MUST say the flow has no further phase.

#### Scenario: No unit ready
- **WHEN** the change is in `build` and every pending unit depends on another pending unit
- **THEN** the next sentence names the waiting units and their unmet `Depends`, and no advance is reported

#### Scenario: Last phase
- **WHEN** the change is in `close` and its issue is closed
- **THEN** the next sentence says the flow has no further phase and no advance is reported

#### Scenario: Blocking question first
- **WHEN** the change is in `define` with an open blocking question Q1 and a failing `spec-format` check
- **THEN** the next sentence asks to answer Q1

#### Scenario: Missing output
- **WHEN** the change is in `define`, started, with no open blocking question and an empty `## Proposal`
- **THEN** the next sentence asks to write the Proposal with `spec_write`

#### Scenario: Not started
- **WHEN** the change is in `define` and its issue has no `Branch` line
- **THEN** the next sentence asks to run `change_start`

#### Scenario: Next unit
- **WHEN** the change is in `build`, U1 is done and U3 depends on U1 and is pending
- **THEN** the next sentence names U3

#### Scenario: Human gate ready
- **WHEN** the change is in `plan`, every output is present and every check passes
- **THEN** the next sentence says the change is ready for the `plan` gate

#### Scenario: Pending gate request
- **WHEN** the change is in `plan` with a pending forge request for `gate:plan`
- **THEN** the next sentence says to wait for the human's answer on the forge

#### Scenario: Stuck report first
- **WHEN** a stuck report is unanswered and Q1 is an open blocking question
- **THEN** the next sentence says to wait for the human's choice on the stuck report

#### Scenario: Frozen unit
- **WHEN** the change is in `build` with a lock and U2 frozen
- **THEN** the next sentence asks to amend U2 with `unit_amend`

#### Scenario: Dismissed gate
- **WHEN** the latest `define` gate result is `dismissed`
- **THEN** the next sentence says to ask the human how to proceed

#### Scenario: Ship approved
- **WHEN** the change is in `ship`, its ship gate is approved and its issue has no `PR` line
- **THEN** the next sentence says to run `change_ship` and no advance is reported

#### Scenario: Blocked unit asks for a stuck report
- **WHEN** the change is in `build`, U2 is blocked by `unit_attempts`, no stuck report is open, and U3 is ready
- **THEN** the next sentence says U2 is BLOCKED and asks to send a stuck report with `spec_stuck`

#### Scenario: Started unit before the next unit
- **WHEN** the change is in `build`, U1 is started, and U3 is ready
- **THEN** the next sentence asks to finish U1 with `unit_finish`

#### Scenario: Review round before the gate
- **WHEN** the change is in `review`, every unit is done and no routed review round records HEAD
- **THEN** the next sentence asks to run `spec_review`, not the `review` gate

#### Scenario: Waived check does not hold the next step
- **WHEN** the `plan` gate was approved with `size-limits` waived and `size-limits` still fails
- **THEN** the next step reports `build` as `advance` and does not ask to fix `size-limits`

#### Scenario: Review approval at an older HEAD
- **WHEN** the review gate was approved at `c3`, a fix commit moved HEAD to `d4`, and a clean round at `d4` is routed
- **THEN** the next sentence asks to request the review gate again and no advance is reported

#### Scenario: Clean merge keeps the approval
- **WHEN** the review gate was approved at `c3` and the only commit after it is a clean merge of `origin/main`
- **THEN** the review approval still counts and no new review gate is asked

#### Scenario: Merge seen before checks
- **WHEN** the change is in `ship`, its pull request is merged with a merge commit, and the change diff is now empty so the `durable-docs` check fails
- **THEN** the next step reports `close` as the phase to advance to

#### Scenario: Merge seen in review
- **WHEN** a feedback round moved the change to `review` and a human then merged its pull request
- **THEN** the next step reports `close` as the phase to advance to

### Requirement: Advance phase
`advancePhase(change, to)` SHALL move the `livespec:phase/<phase>` label forward to a phase whose `requires` include the current phase, or back to any earlier phase, or, when the caller passes that the change's pull request is merged, to the last phase of the flow from any phase, and MUST refuse any other move. It MUST add the new label before removing the old one, so a failure never leaves the issue with no phase label. When `nextStep` reports a phase to advance to, the session SHALL move the change there with `advancePhase` while the forge is writable.

#### Scenario: Forward move
- **WHEN** `advancePhase` moves a change from `define` to `plan`
- **THEN** the issue has label `livespec:phase/plan` and not `livespec:phase/define`

#### Scenario: Skip refused
- **WHEN** `advancePhase` is asked to move from `define` to `build`
- **THEN** it refuses and the labels are unchanged

#### Scenario: Partial failure
- **WHEN** adding the new label succeeds and removing the old one fails
- **THEN** the issue keeps both labels and the next snapshot reports `phase-ambiguous`

#### Scenario: Build complete
- **WHEN** the snapshot shows phase `build` of the default pack with every unit done and the forge is writable
- **THEN** the change is moved to `review`, the successor of `build`

#### Scenario: Merged pull request moves to close
- **WHEN** a change in `review` has a merged pull request and `advancePhase` is called with target `close` and the merged flag
- **THEN** the issue has label `livespec:phase/close` and not `livespec:phase/review`

#### Scenario: Close without merge refused
- **WHEN** `advancePhase` is asked to move a change from `review` to `close` without the merged flag
- **THEN** it refuses and the labels are unchanged
