## MODIFIED Requirements

### Requirement: Result handling
The system SHALL handle a settled run as follows:
- a run with no structured result (`structuredResultError`, error, crash or abort not caused by the parent) SHALL be retried once with the identical packet, then the unit SHALL be `BLOCKED`;
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
- **WHEN** the child's run ends with `error` and no structured result
- **THEN** the dispatch is retried with a packet whose hash equals the first, and a second failure marks the unit `BLOCKED`

#### Scenario: Missing prerequisite opens the dependency gate
- **WHEN** U3's implementer returns `BLOCKED` with reason `missing-prerequisite` and `discovered_deps` is 0 of 2
- **THEN** the parent is told to run `new_dependency` for U3 with the child's evidence, and no attempt is counted for U3

#### Scenario: Missing prerequisite past the cap
- **WHEN** U3's implementer returns `BLOCKED` with reason `missing-prerequisite` and `discovered_deps` is 2 of 2
- **THEN** the parent is told to send a stuck report with `spec_stuck`
