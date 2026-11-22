## MODIFIED Requirements

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
- **WHEN** a test registers gate `new-dependency` with no checks and `spec_gate new-dependency` is approved
- **THEN** a `gate` comment for `new-dependency` is written and the phase does not move

#### Scenario: Named gate option recorded
- **WHEN** a test registers gate `new-dependency` with option `accept`, its checks pass, and the human chooses `accept`
- **THEN** the `gate` comment for `new-dependency` records choice `accept` and no waivers

#### Scenario: Named gate option does not waive
- **WHEN** a test registers gate `new-dependency` with option `accept` and waivable check `size-limits`, `size-limits` fails, and the human chooses `accept`
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
