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
10. in `build`, the next pending unit whose `Depends` are done, or the blocked units when none is ready;
11. the phase gate.

At the gate, the sentence MUST reflect the valid gate result for the phase, meaning the latest own result newer than the latest `stale` comment listing the phase. A superseded latest result counts as no valid result and never falls back to an older one. An approved valid result MUST report the successor as `advance`, except at `ship`. The sentence covers:
- `changes_requested`: revise and request again;
- `dismissed`: ask the human how to proceed;
- superseded: request again;
- an approved `ship` gate: ready to ship.

In the last phase of the flow, the sentence MUST say the flow has no further phase.

#### Scenario: No unit ready
- **WHEN** the change is in `build` and every pending unit depends on another pending unit
- **THEN** the next sentence names the blocked units and their unmet `Depends`, and no advance is reported

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

#### Scenario: Waived check does not hold the next step
- **WHEN** the `plan` gate was approved with `size-limits` waived and `size-limits` still fails
- **THEN** the next step reports `build` as `advance` and does not ask to fix `size-limits`
