## MODIFIED Requirements

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

For the `define` and `review` targets whose phase lists the `behavior-change` check, that check is the one exception: `spec_gate` SHALL evaluate the refusals above with the `behavior-change` results left out, and only when none applies MAY it write the agent's `decision` records of durable-doc-checks "Behavior conclusion at the gate". It SHALL then run the checks again, `behavior-change` included, and refuse without sending the gate request when one that is not waivable fails. `spec_gate` SHALL accept the `behavior` parameter of that requirement for every target and validate its shape before any check, with the briefing.

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

#### Scenario: Bad behavior shape on another target
- **WHEN** `spec_gate plan` runs with a `behavior` entry whose outcome is `maybe`
- **THEN** the tool refuses naming `behavior`, runs no check, and writes nothing

#### Scenario: Behavior answer before a refusal
- **WHEN** `spec_gate define` runs with no other refusal and one behavior item, with `behavior` concluding it `changed`
- **THEN** the agent `decision` record is written, the tool refuses naming `behavior-change`, and no `gate:define` request is sent

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
- **define:** the `Capabilities` line, the `Product impact` line, the Proposal (or its start, with a link to the issue), the stat and files of `git diff <Base>..HEAD -- specs/`, and, when the change has behavior items, a section "Behavior conclusions (please check)" with one line per item: capability, outcome, source, rationale (neutralised) and the number of files;
- **plan:** each unit's id, title, `Difficulty`, `Tags` and `Covers`, with the reason of each decision record and any `agent_additions`;
- **ship:** the `## Durable docs` table, plus the review result when a later spec registers it.

Later specs SHALL be able to add payload for a phase through `registerGatePayload`.

#### Scenario: Plan payload
- **WHEN** `spec_gate plan` sends a forge request for units U1 (`high`, `[security]`) and U2 (`low`, `[]`)
- **THEN** the request comment lists both units with their `Difficulty`, `Tags` and `Covers` and the reasons of their decision records

#### Scenario: Define payload
- **WHEN** `spec_gate define` sends an in-session request
- **THEN** the dialog text includes the `Capabilities` and `Product impact` lines and the changed spec files

#### Scenario: Behavior conclusions listed
- **WHEN** `spec_gate define` sends a forge request after concluding `rate-limit` and `forge-read` `unchanged` with rationales
- **THEN** the request comment's facts, before the briefing, hold a "Behavior conclusions (please check)" section with one line each for `rate-limit` and `forge-read` naming `unchanged`, `agent` and the rationale

#### Scenario: No behavior section without items
- **WHEN** `spec_gate define` sends a request for a change with no behavior item
- **THEN** the payload has no "Behavior conclusions" section

