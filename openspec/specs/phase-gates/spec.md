# phase-gates Specification

## Purpose

Defines `spec_gate` and `registerGate`: per-phase self and human gates, the review payload a human sees, waivable checks, the plugin-written `gate` comment, and how gate outcomes move or keep the phase.

## Requirements

### Requirement: Gate tool
`spec_gate <target>` SHALL accept the current phase id or a gate registered with `registerGate(name, { checks, options })`. It SHALL run that phase's or gate's checks, including its gate-only checks, before it evaluates the refusals below, then:
- for a `self` gate, pass when every check passes;
- for a `human` gate, send a request through the approver chain.

A named gate SHALL always be a `human` gate and MUST NOT move the phase, except through an effect it registers. Its `options` SHALL be offered to the human after the `waive` option, and the chosen option id SHALL be recorded as the gate comment's `choice`. Choosing a named gate's option MUST NOT waive a failing check.

A named gate MAY name a `proposer` tool; `spec_gate` for such a gate MUST refuse and name that tool, which sends the request itself with its drafts and may offer a subset of its options. A gate with a proposer SHALL NOT be bound to HEAD or to the issue body: neither the request nor its validation refuses on a dirty tree, a moved HEAD or a changed body, and its validator checks the forge state it depends on instead. A named gate MAY register a validator with `registerGateValidator(name, fn)`, which completion SHALL run when it validates an answer and which supersedes the answer when it returns a reason. A named gate MAY register effects with `registerGateEffect(name, fn)`; completion SHALL run them, in registration order, only for a valid answer with outcome `approved` or `approved_with_notes`, before the `gate` comment is written. Each effect MUST be skippable when already applied, so a completion left applying can be finished again.

It MUST refuse, writing nothing, when:
- the target is neither the current phase nor a registered named gate;
- the phase gate is `none`;
- a blocking question is open;
- a stuck report is unanswered;
- the iteration cap blocks, as questions-and-stuck "Iteration cap" defines it;
- the change is parked, unless the target is `new-dependency` or `initiative`;
- a request for the same subject is pending;
- the working tree is dirty;
- a check that is not waivable fails.

#### Scenario: Blocking question keeps the gate closed
- **WHEN** Q1 is an open blocking question and `spec_gate define` runs
- **THEN** the tool refuses, names Q1, and requests nothing

#### Scenario: Failing check that is not waivable
- **WHEN** `spec-format` fails in define and `spec_gate define` runs
- **THEN** the tool refuses and names the failing check

#### Scenario: Gate-only check runs at the gate
- **WHEN** the change is in `plan`, `verify-red-on-base` has not run in this session, and `spec_gate plan` runs
- **THEN** `verify-red-on-base` runs before the refusals are evaluated, and its results are in the gate request's review payload

#### Scenario: Forge answer completed without rerunning gate-only checks
- **WHEN** a forge `gate:plan` request was sent after `verify-red-on-base` passed, and a new session completes its `/livespec approve` with HEAD and the issue unchanged
- **THEN** the answer is valid, the plan gate is approved, and no unit's `Verify` runs during the completion

#### Scenario: Self gate
- **WHEN** the change is in `shape`, whose gate is `self`, and `spec_gate shape` runs
- **THEN** a `gate` comment with `by: livespec` and outcome `approved` is written and the change moves to `define`

#### Scenario: Registered gate
- **WHEN** a test registers gate `custom-gate` with no checks and `spec_gate custom-gate` is approved
- **THEN** a `gate` comment for `custom-gate` is written and the phase does not move

#### Scenario: Named gate option recorded
- **WHEN** a test registers gate `custom-gate` with option `accept`, its checks pass, and the human chooses `accept`
- **THEN** the `gate` comment for `custom-gate` records choice `accept` and no waivers

#### Scenario: Named gate option does not waive
- **WHEN** a test registers gate `custom-gate` with option `accept` and waivable check `size-limits`, `size-limits` fails, and the human chooses `accept`
- **THEN** the `gate` comment is marked `superseded` with no waivers and the tool says to choose `waive`

#### Scenario: Gate with a proposer
- **WHEN** a test registers gate `initiative` with proposer `initiative_propose` and `spec_gate initiative` runs
- **THEN** the tool refuses, names `initiative_propose`, and requests nothing

#### Scenario: Gate effect runs once before the result
- **WHEN** a test registers an effect for gate `new-dependency` and an approved answer is completed twice after a crash between the effect and the `gate` comment
- **THEN** the effect's write happens once and one `gate` comment is written after it

#### Scenario: Proposer gate survives work in progress
- **WHEN** `new_dependency` sends its request with uncommitted lane edits, and before the answer a unit is ticked and HEAD moves
- **THEN** the request is sent, and the approved answer is valid

#### Scenario: Parked change refuses the plan gate
- **WHEN** the change is parked and `spec_gate plan` runs
- **THEN** the tool refuses, names the parked state, and requests nothing

#### Scenario: Forge answer on a parked change
- **WHEN** the change is parked and a forge `/livespec approve` answers a `gate:plan` request sent before the park
- **THEN** the answer is recorded as superseded and the phase does not move

#### Scenario: Validator supersedes
- **WHEN** gate `initiative` has a validator that returns a reason, and an approved answer is completed
- **THEN** the answer is recorded as superseded with that reason and no effect runs

#### Scenario: No effect on changes requested
- **WHEN** the `new-dependency` request is answered with `changes`
- **THEN** no registered effect runs

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
`registerCheck(name, fn, { waivable: true })` SHALL mark a check as waivable. When only waivable checks fail at a human gate, the request MUST offer a `waive` option, and the human MAY waive them in the same answer. A plain approve MUST NOT pass a gate with a failing waivable check. Waived checks SHALL be listed in the gate comment's `waivers`. A check waived by the phase's valid gate result MUST NOT hold the next step: the approved gate then moves the change as "Gate outcomes" says, so it moves to the successor except at `ship`, unless a rule earlier in "Next step precedence" holds it. A `self` gate MUST NOT pass with a failing check, waivable or not.

#### Scenario: Waive at the gate
- **WHEN** a test registers waivable check `size-limits` for `plan`, it fails, and the human chooses `waive`
- **THEN** the gate is approved, its comment lists `size-limits` under `waivers`, and the change moves to `build`

#### Scenario: Waived ship gate stays in ship
- **WHEN** a test registers waivable check `size-limits` for `ship`, it fails, and the human chooses `waive` at the ship gate
- **THEN** the gate is approved with `size-limits` under `waivers`, the change stays in `ship`, and the next step says to run `change_ship`

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
- the refusal conditions of the gate tool still do not hold, ignoring the request being completed, so an answer read while the working tree is dirty is superseded.

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

#### Scenario: Dirty tree when the answer is read
- **WHEN** a forge request for `gate:define` is pending, the working tree has uncommitted changes, and a writer approves
- **THEN** the next poll marks the gate comment `superseded`, the recorded answer's reason names the dirty tree, and the change stays in `define`

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
- **THEN** the gate comment is written, the change stays in `ship`, and the next step says to run `change_ship`

#### Scenario: Changes requested
- **WHEN** the define gate gets `changes_requested` with notes
- **THEN** the change stays in `define`, a `stale` comment lists `plan`, `build`, `review`, `ship` and `close`, and the next step asks to revise and request the gate again

#### Scenario: Dismissed
- **WHEN** the plan gate is dismissed
- **THEN** the change stays in `plan` and the next step says to ask the human how to proceed
