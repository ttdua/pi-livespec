## MODIFIED Requirements

### Requirement: Return contract
Each role's result schema SHALL require `status` (`DONE`, `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_CONTEXT`), `notes`, `discoveries` and `sources_used` (source ids), and SHALL accept `reason` and `evidence`. `sources_used` SHALL list every required source of the packet and MAY list optional sources the child used; an optional source missing from it MUST NOT make the result invalid or incomplete. `implementer` SHALL also require `commits`; `reviewer` and `verifier` SHALL also require `findings` in the `review-findings` schema; `reviewer` SHALL also accept `behavior`, a list of `{ capability, outcome, rationale }` as durable-doc-checks "Reviewer behavior conclusion" defines; `verifier` SHALL also require `verdict` (`confirmed` or `refuted`); `scout` SHALL also accept `verdicts`, a list of `{ key, verdict, reason }` with `verdict` `confirmed` or `refuted`, used by the drift audit. `BLOCKED` and `NEEDS_CONTEXT` MUST carry `reason` and `evidence`; the system SHALL treat a result without them as a missing result.

#### Scenario: Blocked without evidence
- **WHEN** a child submits `status: BLOCKED` with no `evidence`
- **THEN** the result is treated as missing and the retry rule applies

#### Scenario: Verifier without a verdict
- **WHEN** a verifier child submits `status: DONE` with no `verdict`
- **THEN** the result is invalid and the child may submit again

#### Scenario: Scout verdicts accepted
- **WHEN** a scout child submits `status: DONE` with `verdicts: [{ key: "dead-paths:x:src/**", verdict: "refuted", reason: "moved" }]`
- **THEN** the result passes the scout schema

#### Scenario: Reviewer behavior accepted
- **WHEN** a reviewer child submits `status: DONE` with `findings` and `behavior: [{ capability: rate-limit, outcome: unchanged, rationale: "refactor" }]`
- **THEN** the result passes the reviewer schema

#### Scenario: Bad behavior outcome
- **WHEN** a reviewer child submits a `behavior` entry with outcome `maybe`
- **THEN** the result is invalid and the child may submit again

#### Scenario: Core sources only
- **WHEN** a change reviewer's packet holds `records:decisions` and `records:dispatch-answers`, and its `DONE` result lists every required source but neither of them
- **THEN** the result is accepted on the first run, not returned to the child, and its `finding-summary` has `completed: true`

