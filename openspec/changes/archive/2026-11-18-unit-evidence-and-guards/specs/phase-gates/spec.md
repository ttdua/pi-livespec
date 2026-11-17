## MODIFIED Requirements

### Requirement: Gate tool
`spec_gate <target>` SHALL accept the current phase id or a gate registered with `registerGate(name, { checks, options })`. It SHALL run that phase's or gate's checks, including its gate-only checks, before it evaluates the refusals below, then:
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
