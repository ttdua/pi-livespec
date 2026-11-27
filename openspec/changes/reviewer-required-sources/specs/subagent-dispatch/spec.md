## MODIFIED Requirements

### Requirement: Return contract
Each role's result schema SHALL require `status` (`DONE`, `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_CONTEXT`), `notes`, `discoveries` and `sources_used` (source ids), and SHALL accept `reason` and `evidence`. `sources_used` SHALL list every required source of the packet and MAY list optional sources the child used; an optional source missing from it MUST NOT make the result invalid or incomplete. `implementer` SHALL also require `commits`; `reviewer` and `verifier` SHALL also require `findings` in the `review-findings` schema; `verifier` SHALL also require `verdict` (`confirmed` or `refuted`); `scout` SHALL also accept `verdicts`, a list of `{ key, verdict, reason }` with `verdict` `confirmed` or `refuted`, used by the drift audit. `BLOCKED` and `NEEDS_CONTEXT` MUST carry `reason` and `evidence`; the system SHALL treat a result without them as a missing result.

#### Scenario: Blocked without evidence
- **WHEN** a child submits `status: BLOCKED` with no `evidence`
- **THEN** the result is treated as missing and the retry rule applies

#### Scenario: Verifier without a verdict
- **WHEN** a verifier child submits `status: DONE` with no `verdict`
- **THEN** the result is invalid and the child may submit again

#### Scenario: Scout verdicts accepted
- **WHEN** a scout child submits `status: DONE` with `verdicts: [{ key: "dead-paths:x:src/**", verdict: "refuted", reason: "moved" }]`
- **THEN** the result passes the scout schema

#### Scenario: Core sources only
- **WHEN** a change reviewer's packet holds `records:decisions` and `records:dispatch-answers`, and its `DONE` result lists every required source but neither of them
- **THEN** the result is accepted on the first run, not returned to the child, and its `finding-summary` has `completed: true`

### Requirement: Result handling
The system SHALL handle a settled run as follows:
- a run with no structured result (`structuredResultError`, error, crash or abort not caused by the parent) SHALL be retried once with the identical packet, then the unit SHALL be `BLOCKED`;
- a result whose `sources_used` lacks a required source of the manifest SHALL be returned to the child once, naming the missing required ids; a second miss SHALL be `BLOCKED`, and the reason of the parent's `BLOCKED` record SHALL name the required ids still missing; an optional source missing from `sources_used` MUST NOT return the result or block the run;
- `NEEDS_CONTEXT` naming source ids SHALL make the parent add those sources and dispatch again, not counted as a failed attempt, at most 2 times per unit, then `spec_stuck`;
- `BLOCKED` with reason `missing-prerequisite` SHALL name `new_dependency` with the unit and the child's evidence (discovered-dependencies "New dependency tool"), or `spec_stuck` while the `discovered_deps` cap blocks, and MUST NOT count as a failed attempt;
- a claimed commit that is not reachable from the child's cwd HEAD, or a claim no receipt or commit supports, MUST NOT count as evidence.

#### Scenario: Missing required source
- **WHEN** an implementer result for U1 omits `answer:Q2`, a required source, from `sources_used`
- **THEN** the child is resumed once with a message naming `answer:Q2`; if the next result still omits it, U1 is `BLOCKED`

#### Scenario: Missing optional source
- **WHEN** a unit reviewer result omits `records:decisions`, an optional source, and lists every required source
- **THEN** the child is not resumed and the result is accepted

#### Scenario: Blocked reason names the omitted ids
- **WHEN** a change reviewer's result omits `file:specs/constraints.md` twice
- **THEN** the run is `BLOCKED` and the reason of its `finding-summary` names `file:specs/constraints.md`

#### Scenario: Needs context capped
- **WHEN** U1's child returns `NEEDS_CONTEXT` a third time
- **THEN** the parent calls `spec_stuck` for U1 instead of dispatching again

#### Scenario: Crash retried once
- **WHEN** the child's run ends with `error` and no structured result
- **THEN** the dispatch is retried with a packet whose hash equals the first, and a second failure marks the unit `BLOCKED`

#### Scenario: Missing prerequisite opens the dependency gate
- **WHEN** U3's implementer returns `BLOCKED` with reason `missing-prerequisite` and `discovered_deps` is 0 of 2
- **THEN** the parent is told to run `new_dependency` for U3 with the child's evidence, and no attempt is counted for U3

#### Scenario: Missing prerequisite past the cap
- **WHEN** U3's implementer returns `BLOCKED` with reason `missing-prerequisite` and `discovered_deps` is 2 of 2
- **THEN** the parent is told to send a stuck report with `spec_stuck`

#### Scenario: Review round with many records does not block
- **WHEN** round 1 of a change review is dispatched for a change with 29 `decision` records and 14 parent answers, and the reviewer returns `DONE` listing only the required sources it was given
- **THEN** the first dispatch is accepted without a return, and its `finding-summary` has status `DONE` and `completed: true`
