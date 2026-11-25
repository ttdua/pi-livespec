## MODIFIED Requirements

### Requirement: Unit amendments
After the lock, `unit_amend` SHALL change the plan in one of three forms:
- `unit_amend U<n>` with a full replacement unit, which edits it;
- `--add` with a new unit, which gets the next id;
- `--drop U<n>`, which removes a unit that is not done.

The tool SHALL re-run the `tags` and `difficulty` decisions for edited and added units, sending a rule's ask through the configured approver chain as a proposal (see "Decision seam"), and validate the whole resulting plan with the LS-02 unit validators. It MUST refuse on any error, and MUST refuse to drop a unit that a remaining unit lists in `Depends`. Otherwise it SHALL send a light gate request that shows only the affected units, with the briefing the agent passed as the optional `briefing` parameter (see request-briefing "Briefing shape"); without one, the request has no briefing section. The briefing SHALL be validated before the classification decisions run, and an invalid one MUST be refused before any request, including a `decide:` request, is sent. On approval, the plugin SHALL:
1. write the body change;
2. post decision records for edited and added units: the rule-decided ones, and for a decision answered by a human a `source: human` record of that answer without `proposal`; a record SHALL be posted unless the unit's current decision for that point and digest already has the same outcome and source, or this amendment already posted it;
3. write an `amendment` comment with the old and new digests.

The new digests then become the locked ones. On any other outcome, nothing changes; a proposal answer recorded while the amendment was pending MUST NOT change any unit's current decision. When the answer is validated, before it is recorded, an amendment whose affected unit's digest or done state differs from the request snapshot MUST be marked superseded, with nothing applied. A recorded amendment answer MUST NOT be validated again while its effects are applied.

`unit_amend` MUST refuse, sending no request, in each of these cases:
- before a lock exists;
- for a done unit with `--drop`;
- while a blocking question is open;
- while a stuck report is unanswered;
- while the `change_iterations` cap is blocking;
- while a blocking request, as defined in "Plan units tool", is open;
- while a classification decision of the edited or added unit is pending a human answer, naming the decision and its request id.

The next id for `--add` SHALL skip every id named in the body, in an `amendment` comment, in a locked digest, or in a decision record that is not the answer of a rule ask; a decision record written by the answer of a rule ask (it names its `request`) MUST NOT reserve an id, so an add that asked a human keeps its id when rerun.

In the classification case, "sending no request" means no amendment gate request: the `decide:` request of the pending decision is the one the tool reports, and like the other comments of a classification ask it stays.

The refusals for blocking questions, stuck reports and the cap SHALL give the same reasons as `spec_gate`. A pending request for a question that is currently non-blocking MUST NOT make `unit_amend` refuse.

#### Scenario: Amendment unfreezes
- **WHEN** U2 is frozen after a web edit and `unit_amend U2` with the edited unit is approved
- **THEN** an `amendment` comment records U2's old and new digests and U2 is no longer frozen

#### Scenario: Add and drop
- **WHEN** `unit_amend --add` adds a unit to a two-unit plan, and `unit_amend --drop U1` with U1 pending is approved
- **THEN** U3 exists with a locked digest and U1 is removed from the body and from the lock

#### Scenario: Drop a done unit
- **WHEN** `unit_amend --drop U1` runs and U1 is done
- **THEN** the tool refuses

#### Scenario: Invalid replacement
- **WHEN** `unit_amend U2` gives a replacement without `verify`
- **THEN** the tool refuses with the `units-format` result and sends no request

#### Scenario: Drop a depended-on unit
- **WHEN** U3 has `Depends: U1` and `unit_amend --drop U1` runs
- **THEN** the tool refuses and names U3

#### Scenario: Unit finished while the drop was pending
- **WHEN** a forge request to drop U1 is pending and U1 is ticked done before a writer approves it
- **THEN** the amendment is marked superseded and U1 stays in the body and the lock

#### Scenario: Blocking question keeps the amendment gate closed
- **WHEN** the plan is locked, `- [ ] Q2 (blocking): <text>` is open, and `unit_amend U1` runs with a valid replacement
- **THEN** the tool refuses, naming Q2, and no request is sent

#### Scenario: Stuck report keeps the amendment gate closed
- **WHEN** the plan is locked, stuck report S1 is unanswered, and `unit_amend --add` runs with a valid unit
- **THEN** the tool refuses, naming S1, and no request is sent

#### Scenario: Iteration cap keeps the amendment gate closed
- **WHEN** the plan is locked, `change_iterations` is at its cap with no stuck answer after the latest counted cascade, and `unit_amend U1` runs
- **THEN** the tool refuses and says to send a stuck report with `spec_stuck`

#### Scenario: Non-blocking question does not block unit_amend
- **WHEN** the plan is locked, `- [ ] Q3 (non-blocking): <text>` is open with its request pending on the forge, and `unit_amend U1` runs with a valid replacement
- **THEN** the light gate request is sent

#### Scenario: Applying answer blocks unit_amend
- **WHEN** the plan is locked, a non-blocking question's answer is applying, and `unit_amend U1` runs with a valid replacement
- **THEN** the tool refuses, names the request, and no request is sent

#### Scenario: Amendment classification asks on the forge
- **WHEN** the plan is locked, the `difficulty` rule asks for the replacement of U1, the chain is `[forge]`, and `unit_amend U1` runs
- **THEN** the tool refuses naming `difficulty.U1` and its `decide:` request id, and no amendment request is sent

#### Scenario: Amendment rerun after a forge answer
- **WHEN** that `decide:difficulty.U1` request was answered with `high` and `unit_amend U1` runs again with the same replacement
- **THEN** the light gate request is sent with U1 `Difficulty: high` and no new `decide:` request is sent

#### Scenario: Dismissed amendment keeps the classification
- **WHEN** U1 reads `Difficulty: low`, `unit_amend U1` with the same contract and an added extra tag asks `difficulty.U1`, the human answers `high`, and the amendment is then dismissed
- **THEN** U1 still reads `Difficulty: low` and `unit-classification` reports no error for U1

#### Scenario: Approved amendment applies the answer
- **WHEN** in that case the amendment is approved instead
- **THEN** U1 reads `Difficulty: high`, its current `difficulty` decision is a `source: human` record `high` without `proposal`, and `unit-classification` reports no error for U1

#### Scenario: Rule outcome after a human answer is recorded
- **WHEN** U1's history for its digest is a rule record `low` then a human record `high`, and an approved amendment of U1 with the same digest has the rule decide `low`
- **THEN** a new rule record `low` is posted, it is U1's current decision, and `unit-classification` reports no error for U1

#### Scenario: Added unit keeps its id across an ask
- **WHEN** the plan has U1 and U2, `unit_amend --add` asks `difficulty.U3` on the forge, the request is answered with `high`, and `unit_amend --add` runs again with the same unit
- **THEN** the light gate request adds U3 with `Difficulty: high`, no new `decide:` request is sent, and once approved `unit-classification` reports no error for U3

#### Scenario: Amendment with a briefing
- **WHEN** the plan is locked and `unit_amend U1` runs with a valid replacement and a briefing recommending `approve`
- **THEN** the light gate request carries that briefing and its `approve` choice is marked recommended
