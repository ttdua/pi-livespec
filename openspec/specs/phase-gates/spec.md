# phase-gates Specification

## Purpose

Defines `spec_gate` and `registerGate`: per-phase self and human gates, the review payload a human sees, waivable checks, the plugin-written `gate` comment, and how gate outcomes move or keep the phase.

## Requirements

### Requirement: Gate tool
`spec_gate <target>` SHALL accept the current phase id or a gate registered with `registerGate(name, { checks, options })`. It SHALL run that phase's or gate's checks, including its gate-only checks, before it evaluates the refusals below, then:
- for a `self` gate, pass when every check passes, unless "Self gate escalation" sends it to the human;
- for a `human` gate, send a request through the approver chain, with the briefing the agent passed as the `briefing` parameter.

For a target whose gate is `human`, the `briefing` parameter SHALL be required, and `spec_gate` SHALL validate its shape (request-briefing "Briefing validation and storage") before it runs any check, asks any question or evaluates the refusals below. Its `recommended` choice, when set, MUST be one the request offers; `approve` MUST NOT be recommended while a waivable check fails, which SHALL be refused after the checks run. For a `self` gate the parameter SHALL be ignored, valid or not, unless the gate escalates ("Self gate escalation"). A proposer tool SHALL require a briefing with `recommended` and `rationale` and SHALL refuse without one, naming `briefing`, before it writes or sends anything. Scenarios in any spec that run `spec_gate` on a human gate SHALL be read as passing a valid briefing unless they say otherwise.

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

For the `define` and `review` targets whose phase lists the `behavior-change` check, that check is the one exception: `spec_gate` SHALL evaluate the refusals above with the `behavior-change` results left out, and only when none applies MAY it write the `decide:behavior-change.<capability>` requests and their `decision` records of durable-doc-checks "Behavior change question at the gate". It SHALL then run the checks again, `behavior-change` included, and refuse without sending the gate request when one that is not waivable fails.

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

#### Scenario: Behavior answer before a refusal
- **WHEN** `spec_gate define` runs with no other refusal and one unanswered behavior item, and the human answers `changed` in session
- **THEN** the `decision` record is written, the tool refuses naming `behavior-change`, and no `gate:define` request is sent

#### Scenario: Human gate without a briefing
- **WHEN** `spec_gate define` runs without `briefing`
- **THEN** the tool refuses, names `briefing`, runs no check, asks nothing and sends no request

#### Scenario: Self gate ignores the briefing
- **WHEN** the change is in `shape` and `spec_gate shape` runs without `briefing`, or with a `briefing` whose `summary` is empty
- **THEN** the self gate passes as before

#### Scenario: Approve not recommended while a check must be waived
- **WHEN** waivable check `size-limits` fails at `plan` and `spec_gate plan` runs with a briefing recommending `approve`
- **THEN** the tool refuses, says to recommend `waive` or another action, and sends no request

#### Scenario: Proposer briefing
- **WHEN** `initiative_propose` runs with valid drafts and a briefing recommending `approve`
- **THEN** the `initiative` request carries that briefing, and without a briefing the tool refuses, names `briefing`, and sends nothing

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
`registerCheck(name, fn, { waivable: true })` SHALL mark a check as waivable. When only waivable checks fail at a human gate, the request MUST offer a `waive` option, and the human MAY waive them in the same answer. A plain approve MUST NOT pass a gate with a failing waivable check. Waived checks SHALL be listed in the gate comment's `waivers`. A check waived by the phase's valid gate result MUST NOT hold the next step: the approved gate then moves the change as "Gate outcomes" says, so it moves to the successor except at `ship`, unless a rule earlier in "Next step precedence" holds it. A `self` gate MUST NOT pass with a failing check, waivable or not; when a waivable check fails at a phase that "Self gate escalation" covers, the gate SHALL escalate to the human instead of refusing.

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
- **WHEN** define and plan were approved, a spec edit in `build` cascades the change back to `define`, and every define check passes
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

### Requirement: Self gate escalation
A `self` phase gate listed in the `gate-escalation` config's `phases` SHALL consult `decide("gate-escalation", facts)` after its checks and refusals; a `human` phase gate MUST NOT. On `human` without a valid `briefing` it MUST refuse naming `briefing`, writing nothing. Otherwise it SHALL append the `decision` `gate-escalation.<phase>` to the ledger unless the latest has equal facts, then pass, or send a human gate, with `waive` when a waivable check fails, whose payload names the reason.

#### Scenario: Plan without triggers passes alone
- **WHEN** the change is in `plan`, every check passes, the plan reviewer's advisory review at HEAD has no `CRITICAL` finding, no unit is tagged `security` or `migration`, and `spec_gate plan` runs without a briefing
- **THEN** a `gate-escalation.plan` decision ledger entry with outcome `self` is appended, a `gate` comment with `by: livespec` records the locked digests, the change moves to `build`, and no request is sent

#### Scenario: Waived size limit asks the human
- **WHEN** the change is in `plan`, `size-limits` fails, and `spec_gate plan` runs with a briefing recommending `waive`
- **THEN** a `gate-escalation.plan` decision ledger entry with outcome `human` names `size-limits`, and a `gate:plan` request offering `waive` is sent

#### Scenario: Security unit asks the human
- **WHEN** the change is in `plan`, every check passes, U2 is tagged `security`, and `spec_gate plan` runs with a briefing recommending `approve`
- **THEN** a `gate:plan` request is sent and its payload names U2's `security` tag as the reason

#### Scenario: Critical advisory finding asks the human
- **WHEN** the plan reviewer's advisory review at HEAD reports a `CRITICAL` finding and `spec_gate plan` runs with a briefing
- **THEN** a `gate:plan` request is sent

#### Scenario: Escalated gate without a briefing
- **WHEN** U2 is tagged `migration` and `spec_gate plan` runs without a briefing
- **THEN** the tool refuses, names `briefing`, sends no request, and appends no `gate-escalation` decision

#### Scenario: Project keeps a human plan gate
- **WHEN** `.pi/livespec/flow.yaml` sets phase `plan` to `gate: human` and no trigger holds
- **THEN** `spec_gate plan` requires a briefing and sends a `gate:plan` request, and no `gate-escalation` decision is appended

#### Scenario: Unlisted self gate unchanged
- **WHEN** the change is in `shape` and `spec_gate shape` runs
- **THEN** no `gate-escalation` decision is appended and the self gate passes as before

### Requirement: Escalation in the next step
Before a gate that "Self gate escalation" covers is requested, the next step SHALL forecast its outcome from the same facts, writing nothing; gate-only checks that have not run are left out. On `human` it SHALL say the gate will ask the human, name the reasons, and say to pass a briefing; it SHALL name a missing advisory review's dispatch first. On `self` it SHALL say the gate can pass, and SHALL add "unless a gate-only check fails" while any gate-only check of the gate has no valid last result (flow-engine "Named checks over LS-02 validators"); for a gate with an unkeyed gate-only check the caveat therefore always stays.

#### Scenario: Next step names the escalation
- **WHEN** the change is in `plan`, every check passes and U1 is tagged `security`
- **THEN** the next step says the plan gate will ask the human because U1 is tagged `security`, and to pass a briefing, and no comment is written

#### Scenario: Failing waivable check names the escalation
- **WHEN** the change is in `plan`, `size-limits` fails and every other check passes
- **THEN** the next step says the plan gate will ask the human because `size-limits` fails, and that the human can waive it or it can be fixed first

#### Scenario: Failing gate-only result names the escalation
- **WHEN** the change is in `plan`, no trigger holds, and `spec_gate plan` ran in this session with `verify-red-on-base` reporting an error for U2 and refused for a missing briefing
- **THEN** the next step says the plan gate will ask the human because `verify-red-on-base` fails, and to pass a briefing

#### Scenario: No gate-only result keeps the caveat
- **WHEN** the change is in `plan`, no trigger holds, and `verify-red-on-base` has no valid last result for the current `Base` and unit digests
- **THEN** the next step says "Checks pass; the plan gate can pass unless a gate-only check fails."

#### Scenario: Passing gate-only result drops the caveat
- **WHEN** the change is in `plan`, no trigger holds, and `verify-red-on-base` has a valid last result with no error for the current `Base` and unit digests
- **THEN** the next step says "Checks pass; the plan gate can pass."
