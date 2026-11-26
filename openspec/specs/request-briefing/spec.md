# request-briefing Specification

## Purpose

TBD

## Requirements

### Requirement: Briefing shape
A request SHALL be able to carry a briefing with:
- `summary`: required, at most 600 characters, with no blank line;
- `watch`: zero to five points to check, each one line of at most 200 characters;
- `recommended`: the id of one offered choice, optional;
- `rationale`: at most 600 characters with no blank line, required when `recommended` is set and not allowed without it.

The offered choices of a gate or amendment request SHALL be its built-in actions (`approve`, `changes`, `dismiss`, and `waive` when offered) plus its options; for other requests they SHALL be the request's options. An option SHALL be able to carry a `description`, one line of at most 200 characters. Lengths SHALL be counted in Unicode code points.

#### Scenario: Recommended choice not offered
- **WHEN** `spec_stuck` runs with options A and B and `recommended: C`
- **THEN** the tool refuses, names `recommended` and the offered ids, and writes nothing

#### Scenario: Rationale missing
- **WHEN** `spec_gate define` runs with a briefing that sets `recommended: approve` and no `rationale`
- **THEN** the tool refuses, names `rationale`, and sends no request

#### Scenario: Summary too long
- **WHEN** a briefing `summary` has 601 characters
- **THEN** the sending tool refuses and names `summary` and the 600-character limit

### Requirement: Briefing validation and storage
A briefing or option text that breaks "Briefing shape" MUST be refused by the tool that sends the request, naming the field and the rule, before the tool runs checks, asks a rule or writes anything. The briefing SHALL be stored in the request record, so the `answer` comment that copies the request shows the briefing the human saw. Reading a stored request SHALL tolerate a missing briefing and missing option descriptions.

#### Scenario: Briefing stored with the request
- **WHEN** a gate request with a briefing is answered on the forge
- **THEN** the `answer` comment's request holds the same briefing

#### Scenario: Request without a briefing
- **WHEN** a pending forge request written before briefings existed is read and answered
- **THEN** it completes as before, and rendering it shows no briefing section

### Requirement: Agent text is untrusted
Agent-supplied text in a request (the briefing, option labels and descriptions, question candidates, the question text, and the stuck report's where, tried and hypothesis) MUST NOT be accepted as an answer, a choice or a fact. Before it is stored, every `<!--` in that text SHALL be broken so it cannot open an HTML comment, and every line of it that starts with `/livespec` SHALL be prefixed so it does not start with `/livespec`. The stored and the rendered text SHALL be the neutralised text, and text read from a request or report stored before this rule SHALL be neutralised when it is rendered. The `## Questions` line of the issue body is not changed by this rule.

#### Scenario: Fake marker neutralised
- **WHEN** a briefing summary contains `<!-- livespec:gate:plan -->`
- **THEN** the posted `request` comment has exactly one livespec marker, its own, and the rendered summary does not open an HTML comment

#### Scenario: Fake command neutralised
- **WHEN** a briefing `watch` point is `/livespec approve`
- **THEN** no line of the posted `request` comment starts with `/livespec approve` outside the "How to answer" section, and the request stays pending

#### Scenario: Option description neutralised
- **WHEN** a stuck option description contains `<!--`
- **THEN** the stored and posted description does not open an HTML comment

### Requirement: Briefing placement and author
Both adapters SHALL show the briefing after the facts livespec computed. Its heading SHALL name its author: "agent-authored, advisory" for a briefing from a tool parameter, and "livespec rule" for a briefing built from a rule ask. A check that fails SHALL be shown by livespec in the facts whatever the briefing says.

#### Scenario: Facts before the briefing
- **WHEN** a plan gate request with failing waivable check `size-limits` and a briefing is rendered for the forge
- **THEN** the checks section naming `size-limits` comes before the briefing section

#### Scenario: Rule briefing not labelled as agent
- **WHEN** a test rule asks with options `x` and `y`, recommends `x` with a rationale, and its request is rendered
- **THEN** its briefing heading names a livespec rule and does not say agent-authored

### Requirement: Built-in action descriptions
For gate and amendment requests, livespec SHALL describe the built-in actions itself, with text that names what follows for the target: approve at `plan` locks the unit digests and moves the change to `build`; approve at `ship` allows `change_ship`; waive lists the checks it waives. These descriptions MUST NOT come from the agent.

#### Scenario: Plan approve described
- **WHEN** a plan gate request is rendered
- **THEN** the approve action is described as locking the unit digests and moving the change to `build`

#### Scenario: Waive lists the checks
- **WHEN** a gate request offers `waive` for failing check `size-limits`
- **THEN** the waive action's description names `size-limits`

### Requirement: Forge request text
The plain text below the yaml of a forge `request` comment SHALL contain, in this order:
1. a heading that states the decision needed, naming the subject and the change;
2. the facts: the request summary, then the files and links;
3. a checks table when the request lists failing waivable checks;
4. the briefing, when there is one;
5. a "How to answer" table with one row per offered choice, giving its description and the exact command to post, the recommended one marked; for a question, a candidate's command is `/livespec answer Q<n> <label>`, and one more row always gives the free-text form `/livespec answer Q<n> <text>`;
6. the full list of accepted commands inside a collapsed `<details>` block.

Livespec-written text SHALL be English. The parser SHALL keep ignoring this text, and the command grammar MUST NOT change.

#### Scenario: Gate comment structure
- **WHEN** `spec_gate define` sends a forge request with a briefing recommending `approve`
- **THEN** the comment shows a "Decision needed" heading, the Proposal and spec diff facts, the briefing, and a "How to answer" table whose `approve` row is marked recommended and shows `/livespec approve`

#### Scenario: Question candidates as commands
- **WHEN** `spec_question` sends Q2 with candidates `per-user limits` and `per-IP limits` on the forge
- **THEN** the "How to answer" table has a row with `/livespec answer Q2 per-user limits` and a row with `/livespec answer Q2 per-IP limits`

#### Scenario: Prefilled answer parses back
- **WHEN** a writer posts the prefilled command of candidate `per-user limits` for Q2
- **THEN** Q2 is answered exactly `per-user limits`

### Requirement: In-session presentation
The in-session adapter SHALL show the facts and then the briefing in the title of its first `select`. Each menu entry SHALL read `<label> — <description>` when the choice has a description, the recommended entry SHALL be listed first and end with ` (Recommended)`, and no entry SHALL show a raw `[<id>]` suffix. The adapter MUST keep mapping the picked label back through its menu table and MUST NOT infer identity from the label text.

#### Scenario: Recommended entry first
- **WHEN** a stuck request has options A and B, B recommended, and is shown in session
- **THEN** the first menu entry is B's label with its description and ` (Recommended)`, and picking it records choice `B`

#### Scenario: Briefing shown before options
- **WHEN** `spec_gate define` runs in session with a briefing
- **THEN** the `select` title contains the define payload followed by the briefing summary and rationale
