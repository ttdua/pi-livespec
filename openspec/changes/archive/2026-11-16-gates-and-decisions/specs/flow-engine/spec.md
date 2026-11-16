## MODIFIED Requirements

### Requirement: Change state from issue and git
The engine SHALL build `changeState` only from the change issue and from git:
- from the issue: the phase label, the parsed body, own marked comments, unit status lines and Questions;
- from git: the current branch, HEAD, a clean or dirty tree, and the diff of `specs/` from `Base` to HEAD.

From own marked comments it SHALL derive pending approver requests, gate results, the unit lock with frozen and stale units, stale phases, an unanswered stuck report and the `change_iterations` state. It MUST NOT use session memory as a source of state. When the forge is in read-only mode, the state MUST be built from cached data and marked stale.

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

### Requirement: Next step precedence
`nextStep` SHALL only be called with a valid pack; the caller reports pack errors instead (see flow-pack). The next-step sentence MUST follow this precedence:
1. missing or ambiguous phase label;
2. change not started after `shape`;
3. unanswered stuck report;
4. pending blocking approver request, or an answered request whose effects are not yet fully applied;
5. the `change_iterations` cap blocking, meaning the count is at the cap and no stuck report was answered after the latest counted cascade;
6. open blocking question;
7. frozen or stale units, while a lock exists and the phase is at or after the phase that outputs `issue#Units`;
8. missing phase output;
9. failing check;
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

### Requirement: Loop counters
Loop counters SHALL be tool-written marked comments of kind `counter` with id `<loop>` or `<loop>.<unit>` and data `{ value }`. Setting a counter MUST edit the existing own counter comment or create one when none exists. A loop MAY instead be counted from other own marked comments; `change_iterations` SHALL be the number of own `stale` comments marked as a counted return to define after a plan approval, and a `counter` comment for it MUST be ignored. The engine SHALL report each counter with its cap from the pack's `loops`.

#### Scenario: Counter shown with cap
- **WHEN** a `counter` comment `review_rounds` has value 2 and the pack cap is 3
- **THEN** `nextStep` reports `review_rounds` as 2 of 3

#### Scenario: Counter update edits in place
- **WHEN** a counter that already has an own comment is set to a new value
- **THEN** that comment is edited and no new comment is created

#### Scenario: Derived iteration count
- **WHEN** the issue has two own `stale` comments marked as counted returns to define and one that is not
- **THEN** `nextStep` reports `change_iterations` as 2 of 5
