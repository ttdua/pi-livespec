## ADDED Requirements

### Requirement: Gate tool
`spec_gate <target>` SHALL accept the current phase id or a gate registered with `registerGate(name, { checks, options })`. It SHALL run that phase's or gate's checks, then:
- for a `self` gate, pass when every check passes;
- for a `human` gate, send a request through the approver chain.

It MUST refuse, writing nothing, when:
- the target is neither the current phase nor a registered named gate;
- the phase gate is `none`;
- a blocking question is open;
- a stuck report is unanswered;
- the iteration cap is reached without a later stuck answer;
- a request for the same subject is pending;
- the working tree is dirty;
- a check that is not waivable fails.

#### Scenario: Blocking question keeps the gate closed
- **WHEN** Q1 is an open blocking question and `spec_gate define` runs
- **THEN** the tool refuses, names Q1, and requests nothing

#### Scenario: Failing check that is not waivable
- **WHEN** `spec-format` fails in define and `spec_gate define` runs
- **THEN** the tool refuses and names the failing check

#### Scenario: Self gate
- **WHEN** the change is in `shape`, whose gate is `self`, and `spec_gate shape` runs
- **THEN** a `gate` comment with `by: livespec` and outcome `approved` is written and the change moves to `define`

#### Scenario: Registered gate
- **WHEN** a test registers gate `new-dependency` with no checks and `spec_gate new-dependency` is approved
- **THEN** a `gate` comment for `new-dependency` is written and the phase does not move

### Requirement: Gate review payload
Every gate request SHALL carry the content the human reviews for that phase, in the dialog for in-session and in the request comment for forge:
- **define:** the `Capabilities` line, the `Product impact` line, the Proposal (or its start, with a link to the issue), and the stat and files of `git diff <Base>..HEAD -- specs/`;
- **plan:** each unit's id, title, `Difficulty`, `Tags` and `Covers`, with the reason of each decision record and any `agent_additions`;
- **ship:** the `## Durable docs` table, plus the review result when a later spec registers it.

Later specs SHALL be able to add payload for a phase through `registerGatePayload`.

#### Scenario: Plan payload
- **WHEN** `spec_gate plan` sends a forge request for units U1 (`high`, `[security]`) and U2 (`low`, `[]`)
- **THEN** the request comment lists both units with their `Difficulty`, `Tags` and `Covers` and the reasons of their decision records

#### Scenario: Define payload
- **WHEN** `spec_gate define` sends an in-session request
- **THEN** the dialog text includes the `Capabilities` and `Product impact` lines and the changed spec files

### Requirement: Waivable checks
`registerCheck(name, fn, { waivable: true })` SHALL mark a check as waivable. When only waivable checks fail at a human gate, the request MUST offer a `waive` option, and the human MAY waive them in the same answer. A plain approve MUST NOT pass a gate with a failing waivable check. Waived checks SHALL be listed in the gate comment's `waivers`. A `self` gate MUST NOT pass with a failing check, waivable or not.

#### Scenario: Waive at the gate
- **WHEN** a test registers waivable check `size-limits` for `plan`, it fails, and the human chooses `waive`
- **THEN** the gate is approved and its comment lists `size-limits` under `waivers`

#### Scenario: Approve without waiving
- **WHEN** a waivable check fails and a writer comments `/livespec approve`
- **THEN** the command is ignored with a warning that the failing check must be waived with `choose waive`

### Requirement: Gate comment
On completion, the plugin SHALL write a `gate` comment with:
- request;
- phase or gate name;
- outcome, choice and notes;
- by, at and adapter;
- `head_sha`, the commit the request saw;
- waivers;
- for the plan gate, the locked digests and the agent-skills commit.

Only an own `gate` comment written after an approver answer, or by a passing self gate, SHALL count as a gate result. At completion, the plugin MUST re-check what the human saw:
- HEAD equals the request's `head_sha`;
- the gate digest of the issue body (without Questions, with unit status lines blanked) is unchanged;
- the refusal conditions of the gate tool still do not hold, ignoring the request being completed.

These checks run once, when the answer is recorded. When any check fails, the comment MUST be marked `superseded`, nothing advances, and the gate must be requested again. Completion MUST write its effects before the `gate` comment, and a recorded answer whose effects were partly applied MUST be finished without being validated again.

#### Scenario: Plan gate locks digests
- **WHEN** the plan gate is approved with units U1 and U2
- **THEN** the `gate` comment lists the digests of U1 and U2 and the active agent-skills commit

#### Scenario: HEAD moved before the answer
- **WHEN** a forge approval arrives after a new commit was made on the branch
- **THEN** the gate comment is marked `superseded`, the phase does not move, and the next step asks to request the gate again

#### Scenario: Forge approval completes
- **WHEN** the only pending request is `gate:define`, nothing changed since it was posted, and a writer comments `/livespec approve`
- **THEN** the gate is approved, not superseded, and the change moves to `plan`

#### Scenario: Issue edited before the answer
- **WHEN** a forge request for `gate:define` is pending, someone edits the Proposal on the web without a new commit, and a writer then approves
- **THEN** the gate comment is marked `superseded` and the change stays in `define`

### Requirement: Gate outcomes
On `approved` or `approved_with_notes`, a phase gate SHALL move the change to the successor through `advancePhase`, except at `ship`, where no phase moves. The move SHALL be derived from the valid gate result of the current phase, so a failed move is retried on the next refresh. The valid gate result is the latest own `gate` comment for that phase that is newer than the latest own `stale` comment listing the phase. When that comment is superseded, there is no valid result, and an older one MUST NOT be used. An older approval MUST NOT reopen a phase after a newer result or `stale` comment. On `changes_requested`, the plugin SHALL write a `stale` comment that lists every phase after the gated one, and the phase MUST NOT move. On `dismissed`, nothing moves, and the next step MUST tell the agent to ask the human how to proceed.

#### Scenario: Define approved
- **WHEN** the define gate is approved in session
- **THEN** the change moves to `plan`

#### Scenario: Old approval not reused after a cascade
- **WHEN** define and plan were approved, an answer in `build` sends the change back to `define`, and every define check passes
- **THEN** the change stays in `define` and the next step says it is ready for the `define` gate

#### Scenario: Superseded result does not fall back
- **WHEN** an older define gate is approved and the latest define gate result is superseded
- **THEN** the change stays in `define` and the next step asks to request the gate again

#### Scenario: Failed move retried
- **WHEN** the define gate comment is written but moving the label fails
- **THEN** the next refresh moves the change to `plan` without another approval

#### Scenario: Ship approved
- **WHEN** the ship gate is approved
- **THEN** the gate comment is written, the change stays in `ship`, and the next step says the change is ready to ship

#### Scenario: Changes requested
- **WHEN** the define gate gets `changes_requested` with notes
- **THEN** the change stays in `define`, a `stale` comment lists `plan`, `build`, `review`, `ship` and `close`, and the next step asks to revise and request the gate again

#### Scenario: Dismissed
- **WHEN** the plan gate is dismissed
- **THEN** the change stays in `plan` and the next step says to ask the human how to proceed
