# subagent-dispatch Specification

## Purpose

Defines how livespec dispatches role work to the subagent executor: capability-based executor detection, the dispatch, answer, packet and record tools, launch options, the post-launch check, the return contract and its handling, child questions, the `dispatch` record and the inline fallback.

## Requirements

### Requirement: Executor detection
The system SHALL look up the subagent executor service at each dispatch under `globalThis[Symbol.for("@ttdua/pi-subagents:service")]`, and only when nothing is published there, under the legacy key `globalThis[Symbol.for("@gotgenes/pi-subagents:service")]`. It SHALL treat the executor as capable only when `spawn`, `wait`, `resume`, `abort`, `childSession` and `getAgentType` are functions. Detection MUST NOT depend on the package name or version. With no capable executor, every role SHALL run inline.

#### Scenario: Capable executor
- **WHEN** the published service has `spawn`, `wait`, `resume`, `abort`, `childSession` and `getAgentType`
- **THEN** a dispatch launches a child through `spawn`

#### Scenario: Missing capability
- **WHEN** the published service has no `wait`
- **THEN** `subagent_dispatch` launches nothing and returns that the role runs inline, with the packet

#### Scenario: New service key
- **WHEN** a capable service is published only under `Symbol.for("@ttdua/pi-subagents:service")`
- **THEN** a dispatch launches a child through it

#### Scenario: Legacy service key
- **WHEN** a capable service is published only under `Symbol.for("@gotgenes/pi-subagents:service")`
- **THEN** a dispatch launches a child through it

#### Scenario: Both keys published
- **WHEN** different services are published under both keys
- **THEN** the service under `@ttdua/pi-subagents:service` is used

#### Scenario: Renamed package
- **WHEN** the service reports an `implementation` other than `@ttdua/pi-subagents` and has every required function
- **THEN** a dispatch launches a child

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

### Requirement: Role agents
The system SHALL launch the executor's agents by role name: `scout` → `scout`, `implementer` → `implementer`, `reviewer` → `reviewer`, `verifier` → `verifier`. It MUST NOT ship, register or edit agent files. When `getAgentType(name)` reports a source other than the executor's built-in, the system SHALL still launch it, warn once per session naming the agent and its file, and record the source in the dispatch record.

#### Scenario: User override used
- **WHEN** `getAgentType("implementer")` reports source `global` from `~/.pi/agent/agents/implementer.md`
- **THEN** the dispatch launches `implementer`, the session shows one warning naming that file, and the dispatch record holds `agentSource: global`

#### Scenario: Disabled role agent
- **WHEN** `getAgentType("reviewer")` returns `undefined`
- **THEN** the dispatch launches nothing and returns that the role runs inline because its agent is disabled

### Requirement: Launch options
Every launch SHALL pass `context: "fresh"`, `contextFiles: false`, `skills: { inherit: false, paths }` with the flow skill files of the role (see `subagent-packets`), `excludeExtensionPackages` with the effective isolation list, `cwd` (the lane worktree, the change worktree, or for the drift audit's scout a temporary worktree of the audited commit), `metadata` and `resultSchema` for the role. `metadata` SHALL hold `owner: livespec`, `change` (`audit` for the drift audit's scout), `role`, `packet` (the packet hash), plus `unit`, `subject`, `lane` and `difficulty` when they apply. A launch MUST NOT pass `model` or `context: "fork"`.

#### Scenario: Implementer launch
- **WHEN** U3 with `Difficulty: medium` is dispatched to `implementer` in the change worktree `/w/c`
- **THEN** `spawn` receives `context` `fresh`, `contextFiles` `false`, `skills.inherit` `false`, `cwd` `/w/c`, metadata with `owner` `livespec`, `unit` `U3` and `difficulty` `medium`, a result schema, thinking `medium`, and no `model`

#### Scenario: Audit scout launch
- **WHEN** `/livespec audit` dispatches its scout for audited commit `bbb`
- **THEN** `spawn` receives as `cwd` a temporary worktree checked out at `bbb`, metadata with `change` `audit`, and no `model`

### Requirement: Other flows excluded
The effective isolation list SHALL be every configured package (pi user and project settings) whose source matches a built-in pattern of a known other flow, plus the user config `isolation.excludePackages`, without duplicates. The built-in patterns SHALL cover at least the Superpowers package and pi-superspec. A user MUST NOT need to configure anything for a known flow to be excluded.

#### Scenario: Superpowers installed
- **WHEN** pi settings list `git:github.com/obra/superpowers`
- **THEN** every launch passes that exact source in `excludeExtensionPackages`

#### Scenario: Extra user exclusion
- **WHEN** the user config sets `isolation.excludePackages: ["npm:acme-flow"]` and no known flow is installed
- **THEN** every launch passes exactly `["npm:acme-flow"]`

### Requirement: Effort and model
The requested thinking level SHALL be the dispatched `Difficulty`: the unit's for unit roles; for change-level roles the highest unit `Difficulty`, or `medium` before units exist; for the drift audit's scout, which has no change, `low`. After each failed attempt of a unit, the dispatched level SHALL rise one step, to at most `high`, without changing the issue. The dispatch record (see `Dispatch record`) SHALL record the requested thinking and the `effectiveModel` and `effectiveThinking` reported for the child, so a router that changed them is visible.

#### Scenario: Raised after a failure
- **WHEN** U2 has `Difficulty: low` and one failed attempt
- **THEN** the next dispatch requests thinking `medium`, and U2's `Difficulty` line is unchanged

#### Scenario: Routed by another layer
- **WHEN** the dispatch requests thinking `low` and the child's `session-created` reports `effectiveThinking` `high` and `effectiveModel` `p/m`
- **THEN** the dispatch record holds requested `low`, effective `high` and model `p/m`

#### Scenario: Audit scout effort
- **WHEN** `/livespec audit` dispatches its scout
- **THEN** the launch requests thinking `low` and sets no model

### Requirement: Post-launch check
On `subagents:child:session-created` for the launch's agent id, the system SHALL compare the effective `context`, `cwd`, `inheritSkills`, `skillPaths` and `contextFiles` with the request, and check that the effective `excludedExtensionPackages` contains every requested package. On any mismatch it MUST abort the child through the service's `abort`, record the mismatch, and run the role inline for this dispatch, except that a `cwd` mismatch in a lane SHALL re-run the unit sequentially (see `parallel-lanes`). A launch whose `session-created` event does not arrive before its run settles SHALL count as a mismatch.

#### Scenario: Skills ignored by the executor
- **WHEN** `session-created` reports `inheritSkills` `true` for a launch that requested `false`
- **THEN** the child is aborted and the dispatch returns that the role runs inline, naming `inheritSkills`

#### Scenario: Exclusion ignored
- **WHEN** a launch requested `excludeExtensionPackages: ["git:github.com/obra/superpowers"]` and `session-created` reports an empty `excludedExtensionPackages`
- **THEN** the child is aborted and the dispatch returns that the role runs inline, naming `excludedExtensionPackages`

#### Scenario: Context forced to fork
- **WHEN** the role's agent file locks `context: fork` and `spawn` refuses the launch
- **THEN** the dispatch returns the executor's refusal and that the role runs inline

### Requirement: Return contract
Each role's result schema SHALL require `status` (`DONE`, `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_CONTEXT`), `notes`, `discoveries` and `sources_used` (source ids), and SHALL accept `reason` and `evidence`. `implementer` SHALL also require `commits`; `reviewer` and `verifier` SHALL also require `findings` in the `review-findings` schema; `verifier` SHALL also require `verdict` (`confirmed` or `refuted`); `scout` SHALL also accept `verdicts`, a list of `{ key, verdict, reason }` with `verdict` `confirmed` or `refuted`, used by the drift audit. `BLOCKED` and `NEEDS_CONTEXT` MUST carry `reason` and `evidence`; the system SHALL treat a result without them as a missing result.

#### Scenario: Blocked without evidence
- **WHEN** a child submits `status: BLOCKED` with no `evidence`
- **THEN** the result is treated as missing and the retry rule applies

#### Scenario: Verifier without a verdict
- **WHEN** a verifier child submits `status: DONE` with no `verdict`
- **THEN** the result is invalid and the child may submit again

#### Scenario: Scout verdicts accepted
- **WHEN** a scout child submits `status: DONE` with `verdicts: [{ key: "dead-paths:x:src/**", verdict: "refuted", reason: "moved" }]`
- **THEN** the result passes the scout schema

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

### Requirement: Questions from a child
When a waited run settles with `pendingQuestion`, `subagent_dispatch` SHALL return the question and the agent id to the parent without interpreting a result. Before returning, `subagent_dispatch` SHALL post a `dispatch` comment with status `QUESTION`, the agent id and the question, so the pending child survives a session reload. `subagent_answer <id> <answer>` SHALL post a `dispatch` comment with status `ANSWERED` for that agent id, then resume that child with the answer, record the answer as source `answer:<id>:<n>`, wait for the run, and handle its result as `subagent_dispatch` does. A question SHALL stay pending until an `ANSWERED` record or a later result record (`dispatch` or `finding-summary`) carries the same agent id; every record of a launched run SHALL carry its agent id. `subagent_answer` MUST refuse an id with no pending question in the current change, and an id the executor no longer knows (the parent then dispatches again). The parent MUST NOT answer a question that only the user can decide (a change of scope, a requirement, a public contract or an acceptance criterion); it SHALL raise it with `spec_question` and answer the child with the user's answer once given. The phase card SHALL show a child with an unanswered question as the next step.

#### Scenario: Ask and answer
- **WHEN** an implementer child asks `Which config file?` and the parent calls `subagent_answer <id> "the project one"`
- **THEN** the child resumes with that answer, and its result may cite `answer:<id>:1` in `sources_used`

#### Scenario: Question for the user
- **WHEN** a child asks whether the rate limit should apply to admins, which no requirement settles
- **THEN** the next step is `spec_question` for that question, and the child is answered with `subagent_answer` only after the user's answer

#### Scenario: Pending question on the card
- **WHEN** a child's question is unanswered
- **THEN** the phase card's next step names the child and its question

### Requirement: Inline fallback
`subagent_packet <role> [U<n>] [subject]` SHALL return the same packet a dispatch would build, without launching. When a role runs inline, the parent SHALL do the work in its own session with that packet and then call `subagent_record <role> [U<n>] [subject]` with the same result shape a child submits; `subagent_record` SHALL validate it against the role's schema and post it as `subagent_dispatch` does. The evidence (receipts, findings, dispatch records, ticks) MUST be the same as for a dispatched run. The drift audit's scout is the one exception: it has no change, so it does not run inline, and its items stay unconfirmed (see `drift-audit`).

#### Scenario: No executor
- **WHEN** no capable executor is present and the next step is the implementer for U1
- **THEN** the phase card says to run U1 inline with `subagent_packet implementer U1` and to finish with `subagent_record implementer U1`, and `unit_start`/`unit_finish` produce the same receipt as with a subagent

#### Scenario: Inline review recorded
- **WHEN** the parent reviews U1 inline and calls `subagent_record reviewer U1 unit` with one finding
- **THEN** a `finding-summary` comment is posted exactly as for a dispatched review

#### Scenario: Audit scout not inline
- **WHEN** `/livespec audit` runs with no capable executor
- **THEN** no `subagent_packet` step is suggested, and the heuristic items are reported unconfirmed

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
