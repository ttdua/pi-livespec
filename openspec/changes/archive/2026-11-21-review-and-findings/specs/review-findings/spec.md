## MODIFIED Requirements

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
