## MODIFIED Requirements

### Requirement: Finding summary comment
After each reviewer or verifier run, dispatched or inline, the parent SHALL post one `finding-summary` comment that records the role, subject, unit, round, the agent id of a launched run, the run's `status`, `sources_used`, the required source ids of its packet, `completed` (see below), whether the entry is advisory, the reviewed HEAD SHA, packet hash, agent source, requested and effective thinking, effective model, the findings, and the run's `notes`, `reason` and `evidence` when they are non-empty. A `BLOCKED` result the parent writes SHALL carry its reason in `reason` and `notes`. A dispatched run's comment SHALL be posted by `subagent_dispatch` or `subagent_answer`; an inline run's by `subagent_record`. The comment SHALL be the only record the flow reads for findings. A review SHALL count as **completed** only when its status is `DONE` or `DONE_WITH_CONCERNS` and its `sources_used` holds every required source; the parent SHALL compute this when posting and record it as `completed`, and readers SHALL use the recorded value. Any other round SHALL resolve nothing and satisfy no review requirement. A `finding-summary` without `notes`, `reason` or `evidence` SHALL stay valid.

#### Scenario: Unit review recorded
- **WHEN** the unit reviewer returns two findings for U1 in round 1
- **THEN** one `finding-summary` comment holds both findings with unit `U1` and round 1

#### Scenario: Why of a run kept
- **WHEN** a unit reviewer returns `DONE_WITH_CONCERNS` with notes `checked the retry path` and a `BLOCKED` reviewer result carries reason `no diff` and evidence `empty range`
- **THEN** the first `finding-summary` records those notes, and the second records that reason and evidence

#### Scenario: Parent-written block names omitted ids
- **WHEN** the parent records a reviewer run as `BLOCKED` because its result still omits `file:specs/constraints.md`
- **THEN** the `finding-summary` has status `BLOCKED` and its `reason` names `file:specs/constraints.md`

#### Scenario: Older summary still valid
- **WHEN** a stored `finding-summary` has no `notes`, `reason` or `evidence`
- **THEN** it validates and is read as before
