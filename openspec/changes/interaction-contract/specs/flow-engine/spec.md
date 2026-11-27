## MODIFIED Requirements

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
12. failing check not waived by the phase's valid gate result, except a waivable check at a phase whose gate phase-gates "Self gate escalation" covers and whose escalation forecast is `human`, which falls through to the gate step (rule 20) so it is reported as an escalation;
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

#### Scenario: Waivable check at an escalating self gate
- **WHEN** the change is in `plan`, whose gate is `self` and covered by `gate-escalation`, and only `size-limits` fails
- **THEN** the next step is the plan gate step naming `size-limits`, not a step to fix it
