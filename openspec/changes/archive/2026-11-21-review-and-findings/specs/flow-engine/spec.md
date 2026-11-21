## MODIFIED Requirements

### Requirement: Next step precedence
`nextStep` SHALL only be called with a valid pack; the caller reports pack errors instead (see flow-pack). The next-step sentence MUST follow this precedence:
1. missing or ambiguous phase label;
2. change not started after `shape`;
3. unanswered stuck report;
4. pending blocking approver request, or an answered request whose effects are not yet fully applied;
5. the `change_iterations` cap blocking, as questions-and-stuck "Iteration cap" defines it;
6. open blocking question;
7. frozen or stale units, while a lock exists and the phase is at or after the phase that outputs `issue#Units`;
8. missing phase output;
9. failing check not waived by the phase's valid gate result;
10. in a `per: unit` phase, a blocked unit: send a stuck report with `spec_stuck`;
11. in a `per: unit` phase, a started unit: finish it with `unit_finish`;
12. in a `per: unit` phase, a receipted unit that is not ticked: run `unit_finish` again;
13. in `build`, the next pending unit whose `Depends` are done, or the units waiting on `Depends` when none is ready;
14. in `review`, the review steps of review-phase "Review next steps";
15. the phase gate.

At the gate, the sentence MUST reflect the valid gate result for the phase, meaning the latest own result newer than the latest `stale` comment listing the phase. A superseded latest result counts as no valid result and never falls back to an older one. An approved valid result MUST report the successor as `advance`, except at `ship`. The sentence covers:
- `changes_requested`: revise and request again;
- `dismissed`: ask the human how to proceed;
- superseded: request again;
- an approved `ship` gate: ready to ship.

In the last phase of the flow, the sentence MUST say the flow has no further phase.

#### Scenario: No unit ready
- **WHEN** the change is in `build` and every pending unit depends on another pending unit
- **THEN** the next sentence names the waiting units and their unmet `Depends`, and no advance is reported

#### Scenario: Last phase
- **WHEN** the change is in `close`
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
- **WHEN** the change is in `ship` and its ship gate is approved
- **THEN** the next sentence says the change is ready to ship and no advance is reported

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

### Requirement: Loop counters
Loop counters SHALL be tool-written marked comments of kind `counter` with id `<loop>` or `<loop>.<unit>` and data `{ value }`. Setting a counter MUST edit the existing own counter comment or create one when none exists. A loop MAY instead be counted from other own marked comments:
- `change_iterations` SHALL be the number of own `stale` comments marked as a counted return to define after a plan approval;
- `unit_attempts.<unit>` SHALL be derived from `progress` decision records, as unit-evidence "Unit attempts and blocked units" defines;
- `review_rounds` SHALL be derived from aggregate review records, as review-phase "Review round cap" defines.

A `counter` comment for a derived loop MUST be ignored. The engine SHALL report each counter with its cap from the pack's `loops`.

#### Scenario: Counter shown with cap
- **WHEN** a `counter` comment `discovered_deps` has value 1 and the pack cap is 2
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

