# flow-engine Specification

## Purpose

Defines the flow engine: the `changeState` snapshot, `nextStep`, the named checks over change issues, loop counters, skill notes, phase advance and the integration branch.

## Requirements

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

### Requirement: Next step
`nextStep(pack, changeState)` SHALL be a pure function. It returns the current phase, the required and optional skills, the redirects, outstanding check results, open blocking questions, counters with their caps, active units, units waiting on `Depends`, started units, blocked units with their reason, the items of the latest `incomplete` comment reconciled with the current state, an optional phase to advance to, and exactly one sentence saying what to do next. Reconciling SHALL drop an item of the form `<unit> is started` whose unit is not started in the change state, and SHALL keep every other item as recorded.

#### Scenario: Pure
- **WHEN** `nextStep` is called twice with equal inputs
- **THEN** both results are deeply equal and no I/O is performed

#### Scenario: Finished unit dropped from incomplete items
- **WHEN** the latest `incomplete` comment lists `U2 is started`, `U3 is started` and `uncommitted changes in the working tree`, U2 has a receipt and is not started, and U3 is still started
- **THEN** the returned incomplete items are `U3 is started` and `uncommitted changes in the working tree`, in that order

#### Scenario: Still-started unit kept
- **WHEN** the latest `incomplete` comment lists `U2 is started` and U2 is still started
- **THEN** the returned incomplete items contain `U2 is started`

#### Scenario: Other items kept as recorded
- **WHEN** the latest `incomplete` comment lists `review pending for U2` and no unit is started
- **THEN** the returned incomplete items are `review pending for U2`

### Requirement: Next step precedence
`nextStep` SHALL only be called with a valid pack; the caller reports pack errors instead (see flow-pack). The next-step sentence MUST follow this precedence:
1. missing or ambiguous phase label;
2. outside the last phase and while the change issue is open, a `PR` line whose pull request is merged or closed without merge: the steps of change-close "Pull request outcome";
3. change not started after `shape`: when a dependency is not merged, name each one with its state and say a human runs `change_start #N` once they merge; otherwise name `change_start #N`;
4. unanswered stuck report;
5. pending blocking approver request, or an answered request whose effects are not yet fully applied;
6. a parked change: the steps of discovered-dependencies "Parked state";
7. an approved `new-dependency` result whose follow-up is not done: the step of discovered-dependencies "New dependency follow-up";
8. the `change_iterations` cap blocking, as questions-and-stuck "Iteration cap" defines it;
9. open blocking question;
10. frozen or stale units, while a lock exists and the phase is at or after the phase that outputs `issue#Units`;
11. missing phase output;
12. failing check not waived by the phase's valid gate result;
13. in a `per: unit` phase, a blocked unit: send a stuck report with `spec_stuck`;
14. in a `per: unit` phase, a started unit: finish it with `unit_finish`;
15. in a `per: unit` phase, a receipted unit that is not ticked: run `unit_finish` again;
16. in `build`, `review` and `ship`, the `change_sync` step of change-initiatives "Sync with the integration branch";
17. in `build`, the next pending unit whose `Depends` are done, or the units waiting on `Depends` when none is ready;
18. in `review`, the review steps of review-phase "Review next steps";
19. in `ship`, the steps of ship-phase "Ship next steps", and in `close`, the steps of change-close "Close next steps";
20. the phase gate.

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

#### Scenario: Parked change waits
- **WHEN** the change is parked waiting for #41 and #41 is open
- **THEN** the next sentence says the change waits for #41, and no unit or gate step is named

#### Scenario: Not started with an unmet dependency
- **WHEN** the change is in `define` with no `Branch` line and `Depends: #34`, and #34 is open
- **THEN** the next sentence names #34 as open and says a human runs `change_start` once it merges

#### Scenario: Park before finishing a started unit
- **WHEN** the latest `new-dependency` result chose A, no `parked` record follows it, and U2 is started in a lane
- **THEN** the next sentence names `change_park`, not `unit_finish U2`

#### Scenario: Sync before the next unit
- **WHEN** the change is in `build` with a ready unit, a sibling entry of its initiative is checked, and `origin/main` is not an ancestor of HEAD
- **THEN** the next sentence names `change_sync`

### Requirement: Successor phase
The successor of a phase SHALL be the first phase, in pack order, whose `requires` include it. A phase with no successor is the last phase. A `gate: none` phase SHALL report its successor as the phase to advance to only when no earlier rule of the precedence applies; for a `per: unit` phase that means every unit is done.

#### Scenario: Build with pending units does not advance
- **WHEN** the change is in `build` (gate `none`), all checks pass, and U3 is pending and ready
- **THEN** the next sentence names U3 and no advance is reported

#### Scenario: Branching custom pack
- **WHEN** a pack has phases `docs` and `review` that both require `build`, with `review` listed first
- **THEN** the successor of `build` is `review`, and a completed `build` reports `review` as the phase to advance to

#### Scenario: Completed build with a human gate
- **WHEN** an override sets `build` to `gate: human` and every unit of a change in `build` is done
- **THEN** the next sentence says the change is ready for the `build` gate and no advance is reported

#### Scenario: Custom successor
- **WHEN** a pack lists phase `docs` requiring `build` before `review`, and every unit of a change in `build` is done
- **THEN** `docs` is reported as the phase to advance to

### Requirement: Named checks over LS-02 validators
The engine SHALL register the named checks `spec-format` (living spec validation of the capabilities the change declares), `units-format`, `done-maps-scenarios` and `capabilities-match-diff`, each returning the LS-02 `Result` list. The engine SHALL run only the checks the active phase lists, and later specs MUST be able to register more checks.

A check MAY be registered as gate-only. A gate-only check SHALL run only when its gate is requested. On every other run of the checks, the engine SHALL report the check's last results that are still valid for the current state, or no result.

#### Scenario: Units check in plan
- **WHEN** the change is in `plan` and unit U2 lacks `Verify`
- **THEN** the outstanding checks contain a `units-format` error for U2

#### Scenario: Only active phase checks
- **WHEN** the change is in `shape`
- **THEN** no check is run

#### Scenario: Gate-only check skipped on refresh
- **WHEN** a test registers gate-only check `slow` for `plan`, and the change state is refreshed twice without a gate request
- **THEN** `slow` does not run and reports no result

#### Scenario: Capabilities mismatch
- **WHEN** the change declares `modified [rate-limit]` and the diff from `Base` touches only `specs/auth/`
- **THEN** `capabilities-match-diff` reports both mismatches

### Requirement: Loop counters
Loop counters SHALL be tool-written marked comments of kind `counter` with id `<loop>` or `<loop>.<unit>` and data `{ value }`. Setting a counter MUST edit the existing own counter comment or create one when none exists. A loop MAY instead be counted from other own marked comments:
- `change_iterations` SHALL be the number of own `stale` comments marked as a counted return to define after a plan approval;
- `unit_attempts.<unit>` SHALL be derived from `progress` decision records, as unit-evidence "Unit attempts and blocked units" defines;
- `review_rounds` SHALL be derived from aggregate review records, as review-phase "Review round cap" defines;
- `discovered_deps` SHALL be derived from `new-dependency` gate results, as discovered-dependencies "Discovered dependencies counter" defines.

A `counter` comment for a derived loop MUST be ignored. The engine SHALL report each counter with its cap from the pack's `loops`.

#### Scenario: Counter shown with cap
- **WHEN** a `counter` comment `custom_loop` has value 1 and the pack sets `loops.custom_loop: 2`
- **THEN** `nextStep` reports `custom_loop` as 1 of 2

#### Scenario: Derived discovered dependencies
- **WHEN** the issue has one valid approved `new-dependency` gate result with choice `A` and an own `counter` comment `discovered_deps` with value 9
- **THEN** `nextStep` reports `discovered_deps` as 1 of 2

#### Scenario: Derived review rounds
- **WHEN** the issue has two aggregate review records and an own `counter` comment `review_rounds` with value 9
- **THEN** `nextStep` reports `review_rounds` as 2 of 3

#### Scenario: Counter update edits in place
- **WHEN** a counter that already has an own comment is set to a new value
- **THEN** that comment is edited and no new comment is created

#### Scenario: Derived iteration count
- **WHEN** the issue has two own `stale` comments marked as counted returns to define and one that is not
- **THEN** `nextStep` reports `change_iterations` as 2 of 5

#### Scenario: Derived unit attempts
- **WHEN** U2 has two own `progress.U2` records after its latest `unit-start`, and an own `counter` comment `unit_attempts.U2` with value 9
- **THEN** `nextStep` reports `unit_attempts.U2` as 2 of 3

### Requirement: Comments cache
The engine SHALL cache the raw comments of a change issue and reuse them while the issue's `updatedAt` is unchanged, for at most 5 minutes, and MUST drop the entry after any livespec write to that issue. Own marked comments MUST be filtered from the cached comments by the current `whoami` login on every read, never stored pre-filtered.

#### Scenario: Comments cache hit
- **WHEN** the snapshot is read twice within 5 minutes and the issue's `updatedAt` did not change
- **THEN** comments are listed from the forge only once

#### Scenario: Account switch
- **WHEN** a counter comment was written by account A, the cache is warm, and the current login becomes B with the same issue `updatedAt`
- **THEN** the counter of A is not counted for B

#### Scenario: Own write invalidates
- **WHEN** `skill_note` posts a comment and the snapshot is read again
- **THEN** comments are listed from the forge again and the new note is present

### Requirement: Skill notes
The marker kind `skill-note` SHALL be registered. The `skill_note` tool SHALL accept a skill name and a one-line reason of 1 to 200 characters, and SHALL post a `skill-note` comment with id `<phase>.<skill>` only when the skill is in the active phase's `skills.optional`. The phase card MUST remind the agent to record a note for every optional skill it read in the session without a note.

#### Scenario: Note posted
- **WHEN** the change is in `build` and `skill_note` is called with `debugging-and-error-recovery` and a one-line reason
- **THEN** a `skill-note` comment `build.debugging-and-error-recovery` is posted with the reason

#### Scenario: Not optional
- **WHEN** `skill_note` is called with a required skill or a skill not in the phase
- **THEN** the tool refuses and posts nothing

#### Scenario: Reminder
- **WHEN** the agent read the `SKILL.md` of optional skill `code-simplification` in `review` and no note exists
- **THEN** the phase card lists `code-simplification` as needing a skill note

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

### Requirement: Advance phase is idempotent
`advancePhase` MUST be idempotent. With exactly one phase label that is not the target, it SHALL perform the normal move. With only the target label, it SHALL succeed without a write. With exactly the target label and one other phase label, it SHALL remove the other one. With no phase label or with other combinations, it MUST refuse with a repair hint.

#### Scenario: Normal move unaffected
- **WHEN** the issue carries only `livespec:phase/define` and the target is `plan`
- **THEN** the normal forward move is performed

#### Scenario: Retry completes the move
- **WHEN** the issue carries `livespec:phase/define` and `livespec:phase/plan` and `advancePhase` is called again with target `plan`
- **THEN** only `livespec:phase/plan` remains

#### Scenario: Already moved
- **WHEN** the issue carries only the target label
- **THEN** `advancePhase` succeeds and makes no forge call that writes

#### Scenario: Three phase labels
- **WHEN** the issue carries three phase labels
- **THEN** `advancePhase` refuses with a repair hint and changes nothing

### Requirement: Integration branch
The integration branch SHALL be the project config key `integrationBranch` or, when unset, the default branch of `origin` read from git. Change branches MUST be created from it. Updates from it MUST be merges and never rebases, and the routing note SHALL state that rule.

#### Scenario: Config wins
- **WHEN** the project config sets `integrationBranch: develop`
- **THEN** `change_start` creates the branch from `origin/develop`

#### Scenario: Default branch
- **WHEN** no `integrationBranch` is set and `origin/HEAD` points at `main`
- **THEN** the integration branch is `main`

#### Scenario: Cannot resolve
- **WHEN** no `integrationBranch` is set and `origin/HEAD` is not set
- **THEN** the tool refuses and asks the user to set `integrationBranch`
