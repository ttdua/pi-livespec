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
`subagent_dispatch` SHALL take a role (`scout`, `implementer`, `reviewer`, `verifier`), a unit id when the role or subject needs one, and for `reviewer` a subject (`spec`, `plan`, `unit`, `change` or `persona:<name>`). It SHALL build the packet (see `subagent-packets`), launch the role's agent, wait for its run, and return the interpreted result. It MUST refuse, launching nothing, when the role or subject is unknown, a needed unit id is missing, the unit does not exist, or the call is made in a child session. It MUST NOT write to the forge before the child's run has settled.

#### Scenario: Unit role without a unit
- **WHEN** `subagent_dispatch implementer` is called with no unit id
- **THEN** it refuses and says a unit id is required

#### Scenario: Called in a child
- **WHEN** `subagent_dispatch` is called in a child session
- **THEN** it refuses and says only the main session dispatches

### Requirement: Role agents
The system SHALL launch the executor's agents by role name: `scout` → `scout`, `implementer` → `implementer`, `reviewer` → `reviewer`, `verifier` → `verifier`. It MUST NOT ship, register or edit agent files. When `getAgentType(name)` reports a source other than the executor's built-in, the system SHALL still launch it, warn once per session naming the agent and its file, and record the source in the dispatch record.

#### Scenario: User override used
- **WHEN** `getAgentType("implementer")` reports source `global` from `~/.pi/agent/agents/implementer.md`
- **THEN** the dispatch launches `implementer`, the session shows one warning naming that file, and the dispatch record holds `agentSource: global`

#### Scenario: Disabled role agent
- **WHEN** `getAgentType("reviewer")` returns `undefined`
- **THEN** the dispatch launches nothing and returns that the role runs inline because its agent is disabled

### Requirement: Launch options
Every launch SHALL pass `context: "fresh"`, `contextFiles: false`, `skills: { inherit: false, paths }` with the flow skill files of the role (see `subagent-packets`), `excludeExtensionPackages` with the effective isolation list, `cwd` (the lane worktree, or the change worktree), `metadata` and `resultSchema` for the role. `metadata` SHALL hold `owner: livespec`, `change`, `role`, `packet` (the packet hash), plus `unit`, `subject`, `lane` and `difficulty` when they apply. A launch MUST NOT pass `model` or `context: "fork"`.

#### Scenario: Implementer launch
- **WHEN** U3 with `Difficulty: medium` is dispatched to `implementer` in the change worktree `/w/c`
- **THEN** `spawn` receives `context` `fresh`, `contextFiles` `false`, `skills.inherit` `false`, `cwd` `/w/c`, metadata with `owner` `livespec`, `unit` `U3` and `difficulty` `medium`, a result schema, thinking `medium`, and no `model`

### Requirement: Other flows excluded
The effective isolation list SHALL be every configured package (pi user and project settings) whose source matches a built-in pattern of a known other flow, plus the user config `isolation.excludePackages`, without duplicates. The built-in patterns SHALL cover at least the Superpowers package and pi-superspec. A user MUST NOT need to configure anything for a known flow to be excluded.

#### Scenario: Superpowers installed
- **WHEN** pi settings list `git:github.com/obra/superpowers`
- **THEN** every launch passes that exact source in `excludeExtensionPackages`

#### Scenario: Extra user exclusion
- **WHEN** the user config sets `isolation.excludePackages: ["npm:acme-flow"]` and no known flow is installed
- **THEN** every launch passes exactly `["npm:acme-flow"]`

### Requirement: Effort and model
The requested thinking level SHALL be the dispatched `Difficulty`: the unit's for unit roles; for change-level roles the highest unit `Difficulty`, or `medium` before units exist. After each failed attempt of a unit, the dispatched level SHALL rise one step, to at most `high`, without changing the issue. The dispatch record (see `Dispatch record`) SHALL record the requested thinking and the `effectiveModel` and `effectiveThinking` reported for the child, so a router that changed them is visible.

#### Scenario: Raised after a failure
- **WHEN** U2 has `Difficulty: low` and one failed attempt
- **THEN** the next dispatch requests thinking `medium`, and U2's `Difficulty` line is unchanged

#### Scenario: Routed by another layer
- **WHEN** the dispatch requests thinking `low` and the child's `session-created` reports `effectiveThinking` `high` and `effectiveModel` `p/m`
- **THEN** the dispatch record holds requested `low`, effective `high` and model `p/m`

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
Each role's result schema SHALL require `status` (`DONE`, `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_CONTEXT`), `notes`, `discoveries` and `sources_used` (source ids), and SHALL accept `reason` and `evidence`. `implementer` SHALL also require `commits`; `reviewer` and `verifier` SHALL also require `findings` in the `review-findings` schema. `BLOCKED` and `NEEDS_CONTEXT` MUST carry `reason` and `evidence`; the system SHALL treat a result without them as a missing result.

#### Scenario: Blocked without evidence
- **WHEN** a child submits `status: BLOCKED` with no `evidence`
- **THEN** the result is treated as missing and the retry rule applies

### Requirement: Result handling
The system SHALL handle a settled run as follows:
- a run with no structured result (`structuredResultError`, error, crash or abort not caused by the parent) SHALL be retried once with the identical packet, then the unit SHALL be `BLOCKED`;
- a result whose `sources_used` lacks a required source of the manifest SHALL be returned to the child once, naming the missing ids; a second miss SHALL be `BLOCKED`;
- `NEEDS_CONTEXT` naming source ids SHALL make the parent add those sources and dispatch again, not counted as a failed attempt, at most 2 times per unit, then `spec_stuck`;
- `BLOCKED` with reason `missing-prerequisite` SHALL go to `spec_stuck` until a dependency gate exists;
- a claimed commit that is not reachable from the child's cwd HEAD, or a claim no receipt or commit supports, MUST NOT count as evidence.

#### Scenario: Missing required source
- **WHEN** an implementer result for U1 omits `answer:Q2`, a required source, from `sources_used`
- **THEN** the child is resumed once with a message naming `answer:Q2`; if the next result still omits it, U1 is `BLOCKED`

#### Scenario: Needs context capped
- **WHEN** U1's child returns `NEEDS_CONTEXT` a third time
- **THEN** the parent calls `spec_stuck` for U1 instead of dispatching again

#### Scenario: Crash retried once
- **WHEN** the child's run ends with `error` and no structured result
- **THEN** the dispatch is retried with a packet whose hash equals the first, and a second failure marks the unit `BLOCKED`

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
`subagent_packet <role> [U<n>] [subject]` SHALL return the same packet a dispatch would build, without launching. When a role runs inline, the parent SHALL do the work in its own session with that packet and then call `subagent_record <role> [U<n>] [subject]` with the same result shape a child submits; `subagent_record` SHALL validate it against the role's schema and post it as `subagent_dispatch` does. The evidence (receipts, findings, dispatch records, ticks) MUST be the same as for a dispatched run.

#### Scenario: No executor
- **WHEN** no capable executor is present and the next step is the implementer for U1
- **THEN** the phase card says to run U1 inline with `subagent_packet implementer U1` and to finish with `subagent_record implementer U1`, and `unit_start`/`unit_finish` produce the same receipt as with a subagent

#### Scenario: Inline review recorded
- **WHEN** the parent reviews U1 inline and calls `subagent_record reviewer U1 unit` with one finding
- **THEN** a `finding-summary` comment is posted exactly as for a dispatched review

### Requirement: Dispatch record
After each settled implementer or scout run, dispatched or inline, the parent SHALL post one own `dispatch` comment, a marker kind this capability registers, holding the role, unit, attempt, packet hash, agent source, requested thinking, effective model and thinking, status, commits, `notes`, `discoveries` and `sources_used`. Reviewer and verifier runs SHALL be recorded in `finding-summary` instead (see `review-findings`). A packet that needs the discoveries or results of a unit SHALL read them from that unit's latest `dispatch` comment.

#### Scenario: Discoveries reach the dependent unit
- **WHEN** U1's implementer submits `discoveries: ["the cache client retries twice"]` and U2 has `Depends: U1`
- **THEN** a `dispatch` comment for U1 holds that discovery, and U2's implementer packet includes it with source id `comment:<id>`

#### Scenario: Marker kind registered
- **WHEN** the extension loads
- **THEN** writing a `dispatch` marker comment succeeds
