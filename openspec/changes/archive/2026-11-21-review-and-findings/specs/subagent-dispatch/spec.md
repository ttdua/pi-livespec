## MODIFIED Requirements

### Requirement: Dispatch tool
`subagent_dispatch` SHALL take a role (`scout`, `implementer`, `reviewer`, `verifier`), a unit id when the role or subject needs one, for `reviewer` a subject (`spec`, `plan`, `unit`, `change` or `persona:<name>`), and for `verifier` a finding reference `<aggregateCommentId>:<index>`. `subagent_packet` and `subagent_record` SHALL take the same finding reference for `verifier`. It SHALL build the packet (see `subagent-packets`), launch the role's agent, wait for its run, and return the interpreted result. It MUST refuse, launching nothing, when the role or subject is unknown, a needed unit id is missing, the unit does not exist, a `verifier` call has no finding reference or one that names no aggregate finding, a finding reference is given for another role, or the call is made in a child session. It MUST NOT write to the forge before the child's run has settled. A verifier run SHALL be recorded as a `finding-summary` with `role: verifier`, the finding reference it verifies and its verdict.

#### Scenario: Unit role without a unit
- **WHEN** `subagent_dispatch implementer` is called with no unit id
- **THEN** it refuses and says a unit id is required

#### Scenario: Called in a child
- **WHEN** `subagent_dispatch` is called in a child session
- **THEN** it refuses and says only the main session dispatches

#### Scenario: Verifier without a finding
- **WHEN** `subagent_dispatch verifier` is called with no finding reference
- **THEN** it refuses, launches nothing, and says a finding reference is required

#### Scenario: Verifier recorded
- **WHEN** the verifier of `c1:0` returns `DONE` with verdict `refuted`
- **THEN** a `finding-summary` with `role: verifier`, `verifies: c1:0` and verdict `refuted` is posted

### Requirement: Return contract
Each role's result schema SHALL require `status` (`DONE`, `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_CONTEXT`), `notes`, `discoveries` and `sources_used` (source ids), and SHALL accept `reason` and `evidence`. `implementer` SHALL also require `commits`; `reviewer` and `verifier` SHALL also require `findings` in the `review-findings` schema; `verifier` SHALL also require `verdict` (`confirmed` or `refuted`). `BLOCKED` and `NEEDS_CONTEXT` MUST carry `reason` and `evidence`; the system SHALL treat a result without them as a missing result.

#### Scenario: Blocked without evidence
- **WHEN** a child submits `status: BLOCKED` with no `evidence`
- **THEN** the result is treated as missing and the retry rule applies

#### Scenario: Verifier without a verdict
- **WHEN** a verifier child submits `status: DONE` with no `verdict`
- **THEN** the result is invalid and the child may submit again
