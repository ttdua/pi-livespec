## MODIFIED Requirements

### Requirement: Finding summary comment
After each reviewer or verifier run, dispatched or inline, the parent SHALL append one `finding-summary` ledger entry (see `ledger-store`) that records the role, subject, unit, round, the agent id of a launched run, the run's `status`, `sources_used`, the required source ids of its packet, `completed` (see below), whether the entry is advisory, the reviewed HEAD SHA, packet hash, agent source, requested and effective thinking, effective model, the findings, and the run's `notes`, `reason` and `evidence` when they are non-empty. A `BLOCKED` result the parent writes SHALL carry its reason in `reason` and `notes`. A dispatched run's entry SHALL be appended by `subagent_dispatch` or `subagent_answer`; an inline run's by `subagent_record`. The entry SHALL be the only record the flow reads for findings, and a finding SHALL be named by the entry's `ref` and its index (`<ref>:<index>`). A review SHALL count as **completed** only when its status is `DONE` or `DONE_WITH_CONCERNS` and its `sources_used` holds every required source; the parent SHALL compute this when posting and record it as `completed`, and readers SHALL use the recorded value. Any other round SHALL resolve nothing and satisfy no review requirement. A `finding-summary` without `notes`, `reason` or `evidence` SHALL stay valid.

#### Scenario: Unit review recorded
- **WHEN** the unit reviewer returns two findings for U1 in round 1
- **THEN** one `finding-summary` entry holds both findings with unit `U1` and round 1, and no comment is posted

#### Scenario: Why of a run kept
- **WHEN** a unit reviewer returns `DONE_WITH_CONCERNS` with notes `checked the retry path` and a `BLOCKED` reviewer result carries reason `no diff` and evidence `empty range`
- **THEN** the first `finding-summary` records those notes, and the second records that reason and evidence

#### Scenario: Parent-written block names omitted ids
- **WHEN** the parent records a reviewer run as `BLOCKED` because its result still omits `file:specs/constraints.md`
- **THEN** the `finding-summary` has status `BLOCKED` and its `reason` names `file:specs/constraints.md`

#### Scenario: Older summary still valid
- **WHEN** a stored `finding-summary` has no `notes`, `reason` or `evidence`
- **THEN** it validates and is read as before


### Requirement: Rebuttal
The parent MAY rebut a blocking finding with the tool `finding_rebut <ref> <index> <reason> <evidence>`, where `<ref>` names a `finding-summary` entry by its `ref` or `from` (see ledger-store "Ledger entries"). It MUST refuse an empty reason or evidence, and a reference that names no `finding-summary` entry of the change by `ref` or `from`, and otherwise appends a `finding-summary` entry that names, by `ref`, the summary it rebuts and, per rebutted finding, its index, the reason and the evidence. A `missed-context` finding MUST NOT be rebutted. A rebutted finding SHALL count as resolved for `unit_finish`, and the rebuttals SHALL be listed in the payload of the next human gate.

#### Scenario: Rebutted warning
- **WHEN** the parent rebuts finding 1 of U1's summary with reason and evidence
- **THEN** `unit_finish U1` no longer refuses for that finding, and the next human gate lists the rebuttal

#### Scenario: Missed context
- **WHEN** the parent calls `finding_rebut` on a `missed-context` finding
- **THEN** the tool refuses and nothing is written

#### Scenario: Rebut without evidence
- **WHEN** `finding_rebut` is called with an empty evidence
- **THEN** the tool refuses and nothing is written

#### Scenario: Comment id refused
- **WHEN** `finding_rebut` is called with a forge comment id that no entry has as `ref` or `from`
- **THEN** the tool refuses, saying the first argument is the `ref` of a finding summary in the ledger, and nothing is written
