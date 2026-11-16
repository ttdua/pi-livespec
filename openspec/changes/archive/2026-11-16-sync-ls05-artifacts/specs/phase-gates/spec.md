## MODIFIED Requirements

### Requirement: Gate tool
`spec_gate <target>` SHALL accept the current phase id or a gate registered with `registerGate(name, { checks, options })`. It SHALL run that phase's or gate's checks, then:
- for a `self` gate, pass when every check passes;
- for a `human` gate, send a request through the approver chain.

A named gate SHALL always be a `human` gate and MUST NOT move the phase. Its `options` SHALL be offered to the human after the `waive` option, and the chosen option id SHALL be recorded as the gate comment's `choice`. Choosing a named gate's option MUST NOT waive a failing check.

It MUST refuse, writing nothing, when:
- the target is neither the current phase nor a registered named gate;
- the phase gate is `none`;
- a blocking question is open;
- a stuck report is unanswered;
- the iteration cap blocks, as questions-and-stuck "Iteration cap" defines it;
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

#### Scenario: Named gate option recorded
- **WHEN** a test registers gate `new-dependency` with option `accept`, its checks pass, and the human chooses `accept`
- **THEN** the `gate` comment for `new-dependency` records choice `accept` and no waivers

#### Scenario: Named gate option does not waive
- **WHEN** a test registers gate `new-dependency` with option `accept` and waivable check `size-limits`, `size-limits` fails, and the human chooses `accept`
- **THEN** the `gate` comment is marked `superseded` with no waivers and the tool says to choose `waive`

### Requirement: Waivable checks
`registerCheck(name, fn, { waivable: true })` SHALL mark a check as waivable. When only waivable checks fail at a human gate, the request MUST offer a `waive` option, and the human MAY waive them in the same answer. A plain approve MUST NOT pass a gate with a failing waivable check. Waived checks SHALL be listed in the gate comment's `waivers`. A check waived by the phase's valid gate result MUST NOT hold the next step: the approved gate then moves the change as "Gate outcomes" says, so it moves to the successor except at `ship`, unless a rule earlier in "Next step precedence" holds it. A `self` gate MUST NOT pass with a failing check, waivable or not.

#### Scenario: Waive at the gate
- **WHEN** a test registers waivable check `size-limits` for `plan`, it fails, and the human chooses `waive`
- **THEN** the gate is approved, its comment lists `size-limits` under `waivers`, and the change moves to `build`

#### Scenario: Waived ship gate stays in ship
- **WHEN** a test registers waivable check `size-limits` for `ship`, it fails, and the human chooses `waive` at the ship gate
- **THEN** the gate is approved with `size-limits` under `waivers`, the change stays in `ship`, and the next step says the change is ready to ship

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
