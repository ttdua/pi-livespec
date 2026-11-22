## MODIFIED Requirements

### Requirement: Phase card content
The card SHALL show:
- the change and its phase;
- the next step and the required skills;
- the active phase's redirects;
- open blocking questions;
- counters with their caps;
- active units, started units and blocked units with their reason;
- the items of the latest `incomplete` comment;
- optional skills that still need a skill note;
- pending approver requests, with subject and adapter;
- frozen and stale units;
- an unanswered stuck report;
- forge command comments ignored by the last poll, with the reason;
- the initiative progress, this change's dependencies with their state, and the ready entries (change-initiatives "Initiative progress on the card");
- the parked state with what it waits for and its wip branches;
- the capability overlap warning;
- the sections registered by other specs.

Forge text MUST be wrapped as untrusted content, and a stale snapshot MUST be stated.

#### Scenario: Card contents
- **WHEN** the change is in `define` with redirects and an open blocking question
- **THEN** the card shows the change number, `define`, the next step, `spec-driven-development`, both redirects and the question wrapped as untrusted

#### Scenario: Stale card
- **WHEN** the snapshot comes from the cache in read-only mode
- **THEN** the card states that the data is stale and that writes are refused

#### Scenario: Registered section
- **WHEN** a test registers a card section
- **THEN** its text appears in the card after the built-in sections

#### Scenario: Pending approvals shown
- **WHEN** a forge request for `gate:plan` is pending and U2 is frozen
- **THEN** the card lists the pending `gate:plan` request with adapter `forge` and names U2 as frozen

#### Scenario: Ignored command shown
- **WHEN** the last poll ignored a `/livespec approve` comment from a user without write access
- **THEN** the card names the comment's author and the reason, wrapped as untrusted

#### Scenario: Evidence shown
- **WHEN** the change is in `build`, U1 is started at pre SHA `abc1234` and U2 is blocked by `progress`
- **THEN** the card names U1 as started with `abc1234` and U2 as BLOCKED with reason `progress`

#### Scenario: Parked and initiative lines
- **WHEN** change #40 of initiative #30 is parked waiting for #41
- **THEN** the card shows `initiative #30`, #41 as open, and the parked state with its wip branches
