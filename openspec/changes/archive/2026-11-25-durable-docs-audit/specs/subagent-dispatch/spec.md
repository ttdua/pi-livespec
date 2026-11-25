## MODIFIED Requirements

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

### Requirement: Launch options
Every launch SHALL pass `context: "fresh"`, `contextFiles: false`, `skills: { inherit: false, paths }` with the flow skill files of the role (see `subagent-packets`), `excludeExtensionPackages` with the effective isolation list, `cwd` (the lane worktree, the change worktree, or for the drift audit's scout a temporary worktree of the audited commit), `metadata` and `resultSchema` for the role. `metadata` SHALL hold `owner: livespec`, `change` (`audit` for the drift audit's scout), `role`, `packet` (the packet hash), plus `unit`, `subject`, `lane` and `difficulty` when they apply. A launch MUST NOT pass `model` or `context: "fork"`.

#### Scenario: Implementer launch
- **WHEN** U3 with `Difficulty: medium` is dispatched to `implementer` in the change worktree `/w/c`
- **THEN** `spawn` receives `context` `fresh`, `contextFiles` `false`, `skills.inherit` `false`, `cwd` `/w/c`, metadata with `owner` `livespec`, `unit` `U3` and `difficulty` `medium`, a result schema, thinking `medium`, and no `model`

#### Scenario: Audit scout launch
- **WHEN** `/livespec audit` dispatches its scout for audited commit `bbb`
- **THEN** `spawn` receives as `cwd` a temporary worktree checked out at `bbb`, metadata with `change` `audit`, and no `model`

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
After each settled implementer or scout run of a change, dispatched or inline, the parent SHALL post one own `dispatch` comment, a marker kind this capability registers, holding the role, unit, attempt, packet hash, agent source, requested thinking, effective model and thinking, status, commits, `notes`, `discoveries` and `sources_used`. Reviewer and verifier runs SHALL be recorded in `finding-summary` instead (see `review-findings`). A scout run of the drift audit, which has no change issue, SHALL post no `dispatch` comment; its result goes into the drift report (see `drift-audit`). A packet that needs the discoveries or results of a unit SHALL read them from that unit's latest `dispatch` comment.

#### Scenario: Discoveries reach the dependent unit
- **WHEN** U1's implementer submits `discoveries: ["the cache client retries twice"]` and U2 has `Depends: U1`
- **THEN** a `dispatch` comment for U1 holds that discovery, and U2's implementer packet includes it with source id `comment:<id>`

#### Scenario: Marker kind registered
- **WHEN** the extension loads
- **THEN** writing a `dispatch` marker comment succeeds

#### Scenario: Audit scout writes no dispatch record
- **WHEN** `/livespec audit` dispatches its scout and the child settles
- **THEN** no `dispatch` comment is posted on any issue
