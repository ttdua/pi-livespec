## MODIFIED Requirements

### Requirement: Dispatch tool
`subagent_dispatch` SHALL take a role (`scout`, `implementer`, `reviewer`, `verifier`), a unit id when the role or subject needs one, for `reviewer` a subject (`spec`, `plan`, `unit`, `change` or `persona:<name>`), and for `verifier` a finding reference `<aggregateCommentId>:<index>`. `subagent_packet` and `subagent_record` SHALL take the same finding reference for `verifier`. It SHALL build the packet (see `subagent-packets`), launch the role's agent, wait for its run, and return the interpreted result. `subagent_dispatch`, `subagent_packet` and `subagent_record` SHALL treat a `unit`, `subject` or `finding` given as the empty string as omitted. They SHALL ignore a non-empty `subject` given for a role other than `reviewer` and a non-empty `finding` given for a role other than `verifier`, without validating it, and SHALL start the tool result with one warning per ignored parameter that names the parameter, its value and the role that takes it; the run and its records SHALL be the same as for a call that omitted it. It MUST refuse, launching nothing, when the role is unknown, a `reviewer` call has no subject or an unknown subject, a needed unit id is missing, the unit does not exist, a `verifier` call has no finding reference or one that names no aggregate finding, or the call is made in a child session. It MUST NOT write to the forge before the child's run has settled. A verifier run SHALL be recorded as a `finding-summary` with `role: verifier`, the finding reference it verifies and its verdict. The tool and parameter descriptions SHALL state which role takes `unit`, `subject` and `finding`, and that a parameter the role does not take is omitted.

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

#### Scenario: Empty parameters are omitted
- **WHEN** `subagent_dispatch` is called with role `scout`, unit `""`, subject `""` and finding `""`
- **THEN** it launches the scout as for `subagent_dispatch scout`, and the result carries no warning

#### Scenario: Subject for a role that takes none
- **WHEN** `subagent_dispatch` is called with role `scout` and subject `spec`
- **THEN** it launches the scout as for `subagent_dispatch scout`, and the result starts with a warning that subject `spec` was ignored because only `reviewer` takes a subject

#### Scenario: Finding for a role that takes none
- **WHEN** `subagent_packet` is called with role `implementer`, unit `U1` and finding `c1:0`
- **THEN** it returns the packet of `implementer U1`, starting with a warning that finding `c1:0` was ignored because only `verifier` takes a finding reference

#### Scenario: Ignored values are not validated
- **WHEN** `subagent_dispatch` is called with role `scout`, subject `vibes` and finding `nope`
- **THEN** it launches the scout as for `subagent_dispatch scout`, and the result starts with two warnings, one for subject `vibes` and one for finding `nope`

#### Scenario: Inline record with an ignored finding
- **WHEN** `subagent_record` is called with role `implementer`, unit `U1`, finding `c1:0` and a valid result
- **THEN** the posted `dispatch` record equals the one of `subagent_record implementer U1` with no finding reference, and the result starts with a warning that finding `c1:0` was ignored

#### Scenario: Required parameters given empty
- **WHEN** `subagent_dispatch` is called with role `implementer` and unit `""`, or with role `verifier` and finding `""`
- **THEN** it refuses, launches nothing, and says a unit id, respectively a finding reference, is required

#### Scenario: Reviewer with an empty subject
- **WHEN** `subagent_dispatch` is called with role `reviewer` and subject `""`
- **THEN** it refuses, launches nothing, and says a reviewer needs a subject
