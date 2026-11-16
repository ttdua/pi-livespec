# unit-planning Specification

## Purpose

Defines how units are planned and locked: `plan_units` as the writer of `## Units` before the lock, the digest lock at plan approval, frozen units, `unit_amend` with its light gate, re-planning after the lock, and the classification consistency check.

## Requirements

### Requirement: Plan units tool
`plan_units` SHALL be the only tool that creates `## Units` before the plan is locked. After the lock, only `unit_amend` and approved classification overrides change unit contracts, and tick tools change status lines only. `plan_units` SHALL take structured units without `Difficulty` and `Tags`, with optional `extra_tags`, and in order:
1. assign ids `U1…Un` with pending status lines;
2. run the `tags` and then the `difficulty` decision for each unit, sending a rule's ask through the configured approver chain;
3. validate the complete rendered units with the LS-02 unit validators;
4. merge the integration branch into the change branch;
5. post one decision record per unit and decision point that a rule decided; a decision answered by a human is already recorded by its answer and MUST NOT be posted again;
6. write `## Units` and `Base`, which is the merged integration commit, in one version-checked body write;
7. after the write succeeds, set the branch's `livespecBase` git config to the new `Base`.

When the write outcome is unknown, the tool MUST re-read the issue and report success and set the config only if the issue shows both the new `Base` and exactly the rendered `## Units`. Before anything else, a run SHALL repair a config that differs from an issue `Base` that is an ancestor of HEAD.

An open request SHALL be blocking when it is applying, when its subject starts with `gate:`, `amend:`, `stuck:` or `decide:` whatever its stored mode, or when it is a pending question request whose question is currently blocking or is no longer in `## Questions`. A pending question request whose question is currently non-blocking in `## Questions` MUST NOT be blocking, whatever its stored mode.

It MUST refuse, writing nothing, when:
- the change is not in the phase whose outputs include `issue#Units`;
- the plan is already locked;
- the tree is dirty;
- a blocking request is open;
- a classification decision is pending a human answer, naming the decision and its request id;
- validation fails.

A merge conflict MUST be aborted and refused.

"Writing nothing" covers the plan's effects: the merge, the rule decision records, `## Units`, `Base` and `livespecBase`. The comments of a classification ask made during the run (its `decide:` request, its answer and the human decision record) SHALL stay when the tool later refuses, and a rerun SHALL reuse the recorded answer as "Decision seam" defines.

#### Scenario: Units written with classification
- **WHEN** `plan_units` runs in `plan` with U1 touching `src/auth/token.ts` and U2 touching `README.md`
- **THEN** U1 has `Tags: [security]` and `Difficulty: high`, U2 has `Tags: []` and `Difficulty: low`, and four decision records are posted

#### Scenario: Base is an ancestor of HEAD
- **WHEN** `plan_units` succeeds after the integration branch gained a commit
- **THEN** `Base` equals the merged integration commit, `git merge-base --is-ancestor <Base> HEAD` succeeds, and the branch's `livespecBase` config holds the same commit

#### Scenario: Unknown outcome with an unchanged base
- **WHEN** the integration branch has not moved, so `Base` is unchanged, the body write throws a transport error, and the re-read shows the old `## Units`
- **THEN** the tool does not report success and says that rerunning `plan_units` will reconcile

#### Scenario: Write conflict keeps the base consistent
- **WHEN** the merge succeeds but the issue write returns a conflict
- **THEN** the issue `Base` and the `livespecBase` config both keep their previous value

#### Scenario: Change start still reconciles
- **WHEN** `plan_units` moved `Base` forward and `change_start #N` is run again
- **THEN** it reconciles without a write and does not report a base mismatch

#### Scenario: Merge conflict
- **WHEN** merging the integration branch conflicts
- **THEN** the merge is aborted, the tree is unchanged, and nothing is written to the issue

#### Scenario: Invalid unit
- **WHEN** a unit has no `verify`
- **THEN** the tool refuses with the `units-format` result and nothing is merged or written

#### Scenario: Locked plan
- **WHEN** the plan gate was approved and `plan_units` runs
- **THEN** it refuses and points to `unit_amend`

#### Scenario: Non-blocking question does not block plan_units
- **WHEN** `- [ ] Q1 (non-blocking): <text>` is open and its `question:Q1` request is pending on the forge, and `plan_units` runs in `plan`
- **THEN** the units are written as if no request were open

#### Scenario: Reclassified question follows its current class
- **WHEN** a `question:Q1` request was stored with mode `blocking` and Q1 now reads `(non-blocking)`, and `plan_units` runs
- **THEN** the units are written; and when instead a `question:Q2` request was stored with mode `async` and Q2 now reads `(blocking)`, `plan_units` refuses and names it

#### Scenario: Applying non-blocking answer blocks plan_units
- **WHEN** a non-blocking question's answer comment exists and its result comment does not, and `plan_units` runs
- **THEN** `plan_units` refuses, names the request, and writes nothing

#### Scenario: Non-question requests block whatever their stored mode
- **WHEN** a `gate:`, `amend:`, `stuck:` or `decide:` request is pending with stored mode `async`, no stuck report is unanswered, and `plan_units` runs
- **THEN** `plan_units` refuses, names the request, and writes nothing

#### Scenario: Request for a missing question blocks
- **WHEN** a `question:Q9` request is pending with stored mode `async` and `## Questions` has no Q9
- **THEN** `plan_units` refuses and names the request

#### Scenario: Classification asks on the forge
- **WHEN** the `difficulty` rule asks for U1 and the interaction chain is `[forge]`, and `plan_units` runs in `plan`
- **THEN** `plan_units` refuses naming `difficulty.U1` and the `decide:difficulty.U1` request id, the branch is not merged, and the body and `Base` are unchanged

#### Scenario: Rerun after a forge answer
- **WHEN** the `decide:difficulty.U1` request was answered with `/livespec choose high` and `plan_units` runs again with the same unit
- **THEN** the units are written with U1 `Difficulty: high`, no new request is sent, and only the rule's `tags.U1` record is posted for U1

#### Scenario: Classification answered in session
- **WHEN** the `difficulty` rule asks for U1, the chain is `[in-session]` and the human selects `high`, and `plan_units` runs
- **THEN** the units are written with U1 `Difficulty: high` and exactly one `difficulty.U1` record exists, with source `human`

#### Scenario: Answer kept across a refused run
- **WHEN** the `difficulty` rule asks for U1, the human selects `high` in session, merging the integration branch conflicts, and after the conflict is resolved `plan_units` runs again with the same unit
- **THEN** the first run refuses with the human `difficulty.U1` record kept, and the rerun writes U1 `Difficulty: high` without asking again

#### Scenario: Tags answer that is not a list of tags
- **WHEN** a test `tags` rule asks for U1 with option ids, the human selects one in session, and `plan_units` runs
- **THEN** `plan_units` refuses saying the `tags.U1` answer is not a list of tags, and nothing is merged or written

### Requirement: Digest lock and frozen units
The lock SHALL be the digests in the latest approved, non-superseded plan `gate` comment, updated by every later approved amendment. Once a lock exists, a unit SHALL be frozen when its current `unitDigest` differs from its locked digest, or when it has no locked digest. This includes edits made on the web. `Difficulty`, `Tags` and the status line MUST NOT affect frozen state. The change state SHALL expose frozen units for LS-06's `unit_start` and `unit_finish`.

#### Scenario: Web edit freezes a unit
- **WHEN** after plan approval a human edits U2's `Verify` on the web
- **THEN** U2 is frozen and the next step asks to amend it with `unit_amend`

#### Scenario: Tick does not freeze
- **WHEN** U1's status line is ticked after plan approval
- **THEN** U1 is not frozen

### Requirement: Unit amendments
After the lock, `unit_amend` SHALL change the plan in one of three forms:
- `unit_amend U<n>` with a full replacement unit, which edits it;
- `--add` with a new unit, which gets the next id;
- `--drop U<n>`, which removes a unit that is not done.

The tool SHALL re-run the `tags` and `difficulty` decisions for edited and added units, sending a rule's ask through the configured approver chain as a proposal (see "Decision seam"), and validate the whole resulting plan with the LS-02 unit validators. It MUST refuse on any error, and MUST refuse to drop a unit that a remaining unit lists in `Depends`. Otherwise it SHALL send a light gate request that shows only the affected units. On approval, the plugin SHALL:
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

### Requirement: Re-planning after the lock
After the first lock, `plan_units` MUST refuse, and every unit change SHALL go through `unit_amend`. While a lock exists, the plan gate MUST refuse when any unit is frozen or stale. When the plan gate is approved again, its comment SHALL lock the digests of every unit in the body. Status lines of unchanged units MUST be kept.

A unit SHALL stop being stale when, after the `stale` comment that named it, either an amendment for it is approved, even one whose content is identical to the current unit, or a plan gate is approved and not superseded. A unit made stale before the first lock is therefore cleared by the first plan approval.

#### Scenario: Second plan gate re-locks
- **WHEN** after a cascade the stale units are amended and the plan gate is approved again
- **THEN** the new plan `gate` comment locks the digests of every unit in the body

#### Scenario: Plan gate with a stale unit
- **WHEN** a lock exists, U3 is stale, and `spec_gate plan` runs
- **THEN** the tool refuses and names U3

#### Scenario: Stale before the first lock
- **WHEN** in `plan` before any plan gate was approved, an answer's cascade marks U2 stale and moves the change to `define`, and the define and plan gates are then approved
- **THEN** U2 is not stale and the next step does not ask to amend it

#### Scenario: Identical amendment clears a stale unit
- **WHEN** a lock exists, U3 is stale, and an amendment of U3 with unchanged content is approved
- **THEN** U3 is no longer stale

### Requirement: Unit classification check
The `unit-classification` check SHALL report an error for a unit whose `Difficulty` or `Tags` differ from the latest decision record for that unit and point, and for a unit with no such record. Records for a digest that is not in the body MUST be ignored. A `source: human` record from an answered rule ask for the unit's current digest SHALL count as that unit's decision record. The default pack SHALL list the check in the `plan` phase.

#### Scenario: Tag removed in the body
- **WHEN** U1 was written with `Tags: [security]` and someone removes `security` from the body
- **THEN** `unit-classification` reports an error for U1 and the plan gate refuses

#### Scenario: Human answer satisfies the check
- **WHEN** U1's `difficulty` was answered by a human through a rule ask and `plan_units` wrote U1 with that outcome
- **THEN** `unit-classification` reports no error for U1 and no `source: rule` `difficulty.U1` record exists for its digest
