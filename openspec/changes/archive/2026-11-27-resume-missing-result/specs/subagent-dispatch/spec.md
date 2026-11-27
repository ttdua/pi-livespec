## MODIFIED Requirements

### Requirement: Dispatch tool
`subagent_dispatch` SHALL take a role (`scout`, `implementer`, `reviewer`, `verifier`), a unit id when the role or subject needs one, for `reviewer` a subject (`spec`, `plan`, `unit`, `change` or `persona:<name>`), and for `verifier` a finding reference `<aggregateCommentId>:<index>`. `subagent_packet` and `subagent_record` SHALL take the same finding reference for `verifier`. It SHALL build the packet (see `subagent-packets`), launch the role's agent, wait for its run, and return the interpreted result. `subagent_dispatch`, `subagent_packet` and `subagent_record` SHALL treat a `unit`, `subject` or `finding` given as the empty string as omitted. They SHALL ignore a non-empty `subject` given for a role other than `reviewer` and a non-empty `finding` given for a role other than `verifier`, without validating it, and SHALL start the tool result with one warning per ignored parameter that names the parameter, its value and the role that takes it; the run and its records SHALL be the same as for a call that omitted it. It MUST refuse, launching nothing, when the role is unknown, a `reviewer` call has no subject or an unknown subject, a needed unit id is missing, the unit does not exist, a `verifier` call has no finding reference or one that names no aggregate finding, or the call is made in a child session. It MUST refuse, launching nothing and naming the agent id, while the same target (role, unit, subject and finding reference) already has a `subagent_dispatch` or `subagent_answer` call in flight in this session, or has a pending question (see "Questions from a child") whose child the executor still knows. A child counts as known unless the executor's `getRecord` reports it unknown; a pending question whose child the executor no longer knows SHALL NOT block. `subagent_answer` MUST refuse in the same way while the target of the child it would resume has a call in flight. A `QUESTION` record of a verifier SHALL carry its finding reference, so a question matches only its own target. With no capable executor the role runs inline and this guard does not apply. The concurrent dispatches of `spec_review` are outside this guard. It MUST NOT write to the forge before the child's run has settled. A verifier run SHALL be recorded as a `finding-summary` with `role: verifier`, the finding reference it verifies and its verdict. The tool and parameter descriptions SHALL state which role takes `unit`, `subject` and `finding`, and that a parameter the role does not take is omitted.

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

#### Scenario: Second dispatch while one runs
- **WHEN** `subagent_dispatch implementer U2` is called while an earlier `subagent_dispatch implementer U2` call still waits on child `agent-1`
- **THEN** it refuses, launches nothing, and names `agent-1`

#### Scenario: Dispatch while a question waits
- **WHEN** U2's child `agent-1` has an unanswered `QUESTION` record and the executor still knows `agent-1`
- **THEN** `subagent_dispatch implementer U2` refuses, launches nothing, names `agent-1` and points to `subagent_answer`

#### Scenario: Stale question does not block
- **WHEN** U2's child `agent-1` has an unanswered `QUESTION` record and the executor no longer knows `agent-1`
- **THEN** `subagent_dispatch implementer U2` launches a new child

### Requirement: Result handling
The system SHALL handle a settled run as follows:
- a run with no usable structured result (`structuredResultError`, a result that fails the role's schema, an error, a crash or an abort not caused by the parent) SHALL be retried once: the system SHALL resume the same child with a message that names the reason and asks it to submit its result with the result tool. It MUST NOT launch a new child unless the executor refuses the resume or the resume fails; then it SHALL launch one new child with the identical packet, post a `dispatch` record with status `RETRY` naming the old agent id, the new agent id and the reason once that child's run has settled, and state the respawn in the tool result. A fallback child that is aborted for a launch mismatch or cancelled leaves no `RETRY` record. At most one fallback respawn SHALL happen per dispatch: when the child being resumed was itself launched as a fallback (a `RETRY` record names it as `newAgentId`), a resume that is refused or fails SHALL mark the unit `BLOCKED` instead. A resume interrupted by the user's cancel SHALL end as cancelled, launching nothing and posting no `RETRY` record. If the retried run still has no usable result, the unit SHALL be `BLOCKED`. `subagent_answer` SHALL apply the same rule to the run it resumes;
- a result whose `sources_used` lacks a required source of the manifest SHALL be returned to the child once, naming the missing ids; a second miss SHALL be `BLOCKED`;
- `NEEDS_CONTEXT` naming source ids SHALL make the parent add those sources and dispatch again, not counted as a failed attempt, at most 2 times per unit, then `spec_stuck`;
- `BLOCKED` with reason `missing-prerequisite` SHALL name `new_dependency` with the unit and the child's evidence (discovered-dependencies "New dependency tool"), or `spec_stuck` while the `discovered_deps` cap blocks, and MUST NOT count as a failed attempt;
- a claimed commit that is not reachable from the child's cwd HEAD, or a claim no receipt or commit supports, MUST NOT count as evidence.

#### Scenario: Missing required source
- **WHEN** an implementer result for U1 omits `answer:Q2`, a required source, from `sources_used`
- **THEN** the child is resumed once with a message naming `answer:Q2`; if the next result still omits it, U1 is `BLOCKED`

#### Scenario: Needs context capped
- **WHEN** U1's child returns `NEEDS_CONTEXT` a third time
- **THEN** the parent calls `spec_stuck` for U1 instead of dispatching again

#### Scenario: Crash retried once
- **WHEN** the child `agent-1` ends its run with `error`, or with text only, and no structured result
- **THEN** `agent-1` is resumed once with a message that names the reason and asks for its result, no new child is spawned, and a second run without a result marks the unit `BLOCKED`

#### Scenario: Resumed child submits its result
- **WHEN** the child `agent-1` ends with text only, is resumed, and then submits a valid `DONE` result
- **THEN** the result is recorded with `agentId: agent-1`, and no `RETRY` record is posted

#### Scenario: Refused resume falls back to one new child
- **WHEN** the child `agent-1` ends with `error` and no structured result, and the executor refuses to resume it
- **THEN** exactly one new child `agent-2` is launched with a packet whose hash equals the first, a `dispatch` record with status `RETRY` names `agent-1`, `agent-2` and the reason, the tool result says `agent-1` was replaced by `agent-2`, and a failure of `agent-2` marks the unit `BLOCKED`

#### Scenario: Missing result after an answer
- **WHEN** `subagent_answer agent-1 "<answer>"` resumes the child and its run ends with text only
- **THEN** `agent-1` is resumed again with a message asking for its result, and no new child is spawned

#### Scenario: One fallback respawn per dispatch
- **WHEN** U2 has a `RETRY` record from `agent-1` to `agent-2`, `agent-2` asks a question, `subagent_answer agent-2` resumes it, its run ends without a result, and the executor refuses to resume `agent-2`
- **THEN** no new child is spawned and U2 is `BLOCKED`

#### Scenario: Missing prerequisite opens the dependency gate
- **WHEN** U3's implementer returns `BLOCKED` with reason `missing-prerequisite` and `discovered_deps` is 0 of 2
- **THEN** the parent is told to run `new_dependency` for U3 with the child's evidence, and no attempt is counted for U3

#### Scenario: Missing prerequisite past the cap
- **WHEN** U3's implementer returns `BLOCKED` with reason `missing-prerequisite` and `discovered_deps` is 2 of 2
- **THEN** the parent is told to send a stuck report with `spec_stuck`

### Requirement: Dispatch record
After each settled implementer or scout run of a change, dispatched or inline, the parent SHALL post one own `dispatch` comment, a marker kind this capability registers, holding the role, unit, attempt, packet hash, agent source, requested thinking, effective model and thinking, status, commits, `notes`, `discoveries` and `sources_used`. Reviewer and verifier runs SHALL be recorded in `finding-summary` instead (see `review-findings`). A scout run of the drift audit, which has no change issue, SHALL post no `dispatch` comment; its result goes into the drift report (see `drift-audit`). A fallback respawn (see "Result handling") SHALL post one `dispatch` comment with status `RETRY`, the role, unit, subject and finding reference when present, attempt, the old `agentId`, the `newAgentId` and the reason, for every role, except the drift audit's scout, which posts nothing; it is not a settled run and MUST NOT count as an attempt or be read as the unit's result. As the latest record of the old agent id, it ends that child's pending question. A packet that needs the discoveries or results of a unit SHALL read them from that unit's latest settled `dispatch` comment.

#### Scenario: Discoveries reach the dependent unit
- **WHEN** U1's implementer submits `discoveries: ["the cache client retries twice"]` and U2 has `Depends: U1`
- **THEN** a `dispatch` comment for U1 holds that discovery, and U2's implementer packet includes it with source id `comment:<id>`

#### Scenario: Marker kind registered
- **WHEN** the extension loads
- **THEN** writing a `dispatch` marker comment succeeds

#### Scenario: Audit scout writes no dispatch record
- **WHEN** `/livespec audit` dispatches its scout and the child settles
- **THEN** no `dispatch` comment is posted on any issue

#### Scenario: Retry record is not a result
- **WHEN** U1 has a `RETRY` dispatch record for attempt 1 and no settled run record
- **THEN** the next attempt of U1 is 1, and no packet reads the `RETRY` record as U1's result
