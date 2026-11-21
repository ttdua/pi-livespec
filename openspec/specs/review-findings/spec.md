# review-findings Specification

## Purpose

Defines the finding schema that every reviewer and verifier reports, which findings block `unit_finish`, the `finding-summary` record, rebuttals, and when a later review resolves a finding.

## Requirements

### Requirement: Finding schema
Every reviewer and verifier result SHALL report findings as a list of maps with exactly these fields: `severity` (`CRITICAL`, `WARNING` or `SUGGESTION`), `kind` (`defect`, `missed-context`, `lowered-standard`, `files-violation` or `other`), `location` (`path:line`), `evidence`, `fix` and `scope` (`unit`, `in-change`, `out-of-scope` or `needs-decision`). A finding missing a field MUST make the result invalid.

#### Scenario: Valid finding
- **WHEN** a reviewer submits a finding with all six fields
- **THEN** the result is accepted

#### Scenario: Missing location
- **WHEN** a finding has no `location`
- **THEN** `submit_result` rejects the result and the child may submit again

### Requirement: Blocking findings
A finding of a non-advisory review SHALL be blocking when its severity is `CRITICAL` or `WARNING`, or its kind is `missed-context`. Findings of an advisory review SHALL NOT be blocking. A blocking finding with scope `needs-decision` or `out-of-scope` SHALL NOT require a fix round. A `needs-decision` finding SHALL be raised with `spec_question` and SHALL count as resolved for `unit_finish` once that question is answered. An `out-of-scope` finding MUST NOT refuse `unit_finish`; it SHALL be listed in the payload of the next human gate until a gate has shown it. For an aggregate review finding (see `finding-routing`), the computed route SHALL replace the reviewer's `scope` in these rules (`question` for `needs-decision`, `out-of-scope` for `out-of-scope`), and a `DISPUTED` aggregate finding MUST NOT be blocking.

#### Scenario: Needs a decision
- **WHEN** a unit review reports a `WARNING` with scope `needs-decision`
- **THEN** the next step is `spec_question`, not a fix round

#### Scenario: Out of scope does not block the tick
- **WHEN** a unit review reports a `CRITICAL` finding with scope `out-of-scope` for U1, and no human gate has run since
- **THEN** `unit_finish U1` does not refuse for that finding, and the next human gate payload lists it

#### Scenario: Reviewer scope ignored in an aggregate
- **WHEN** a reviewer marks a `WARNING` at a file of U2's `Files` with scope `out-of-scope`, and the finding is confirmed by the verifier
- **THEN** the aggregate finding is routed `unit` to U2 and blocks the review gate

#### Scenario: Disputed finding
- **WHEN** an aggregate `CRITICAL` finding is `DISPUTED`
- **THEN** it does not block and is not listed as an out-of-scope follow-up

### Requirement: Finding summary comment
After each reviewer or verifier run, dispatched or inline, the parent SHALL post one `finding-summary` comment that records the role, subject, unit, round, the agent id of a launched run, the run's `status`, `sources_used`, the required source ids of its packet, `completed` (see below), whether the entry is advisory, the reviewed HEAD SHA, packet hash, agent source, requested and effective thinking, effective model, and the findings. A dispatched run's comment SHALL be posted by `subagent_dispatch` or `subagent_answer`; an inline run's by `subagent_record`. The comment SHALL be the only record the flow reads for findings. A review SHALL count as **completed** only when its status is `DONE` or `DONE_WITH_CONCERNS` and its `sources_used` holds every required source; the parent SHALL compute this when posting and record it as `completed`, and readers SHALL use the recorded value. Any other round SHALL resolve nothing and satisfy no review requirement.

#### Scenario: Unit review recorded
- **WHEN** the unit reviewer returns two findings for U1 in round 1
- **THEN** one `finding-summary` comment holds both findings with unit `U1` and round 1

### Requirement: Rebuttal
The parent MAY rebut a blocking finding with the tool `finding_rebut <commentId> <index> <reason> <evidence>`, which MUST refuse an empty reason or evidence and otherwise posts a `finding-summary` comment that names the summary it rebuts and, per rebutted finding, its index, the reason and the evidence. A `missed-context` finding MUST NOT be rebutted. A rebutted finding SHALL count as resolved for `unit_finish`, and the rebuttals SHALL be listed in the payload of the next human gate.

#### Scenario: Rebutted warning
- **WHEN** the parent rebuts finding 1 of U1's summary with reason and evidence
- **THEN** `unit_finish U1` no longer refuses for that finding, and the next human gate lists the rebuttal

#### Scenario: Missed context
- **WHEN** the parent calls `finding_rebut` on a `missed-context` finding
- **THEN** the tool refuses and nothing is posted

#### Scenario: Rebut without evidence
- **WHEN** `finding_rebut` is called with an empty evidence
- **THEN** the tool refuses and nothing is posted

### Requirement: Resolution by review
A blocking finding SHALL be resolved when a later completed review round of the same unit and subject reports no blocking finding at the same location and kind, or when it is rebutted or routed as `Blocking findings` describes.

#### Scenario: Fixed and re-reviewed
- **WHEN** round 2 of U1's unit review is completed and reports no findings
- **THEN** every finding of round 1 counts as resolved

#### Scenario: Blocked round resolves nothing
- **WHEN** round 2 of U1's unit review has status `BLOCKED` and no findings
- **THEN** the findings of round 1 stay unresolved

#### Scenario: Advisory unit review
- **WHEN** a pack declares the `build` unit reviewer with `advisory: true` and it reports a `CRITICAL` finding for U1
- **THEN** `unit_finish U1` does not refuse for that finding, and the next human gate lists it
