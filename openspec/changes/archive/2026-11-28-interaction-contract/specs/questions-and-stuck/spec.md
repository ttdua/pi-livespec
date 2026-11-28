## MODIFIED Requirements

### Requirement: Question tool
`spec_question` SHALL append `- [ ] Q<n> (blocking): <text>` to `## Questions` with the next free number. The agent MUST NOT choose the class: a call with a `class` parameter MUST be refused, writing nothing. Only livespec code MAY raise a question as `(non-blocking)` (finding-routing "Route effects"). The question SHALL then go through the approver with kind `question`: mode `blocking` for blocking questions and `async` for non-blocking ones. `spec_question` with `reask: Q<n>` SHALL send an open question again. The question text MUST be one line.

The agent MUST give two to four candidate answers, each with a label and a description, and MUST recommend one with a rationale (see request-briefing "Briefing shape"); a call without them MUST be refused, writing nothing. Livespec SHALL give the candidates the option ids `A`, `B`, `C` and `D` in the order given, and `recommended` SHALL name one of those ids. A candidate label MUST be one line with no leading, trailing or repeated whitespace, MUST NOT contain a word starting with `--`, and MUST differ from every other candidate label, so its prefilled `/livespec answer` command parses back to exactly that label. The human SHALL stay free to write any other answer. Candidates SHALL NOT be written into the `## Questions` line. With `reask`, the candidates of the new call SHALL be used.

#### Scenario: Blocking by default
- **WHEN** `spec_question` runs with text, two candidates, `recommended: A` and a rationale
- **THEN** `## Questions` gains `- [ ] Q<n> (blocking): <text>` and a blocking request is sent

#### Scenario: Non-blocking proposal
- **WHEN** `spec_question` runs with class `non-blocking`
- **THEN** the tool refuses, says the class was removed, and writes nothing

#### Scenario: Question without candidates refused
- **WHEN** `spec_question` runs with only text
- **THEN** the tool refuses, names `candidates`, and writes nothing

#### Scenario: Reask needs candidates
- **WHEN** `spec_question` runs with `reask: Q1` and no candidates
- **THEN** the tool refuses, names `candidates`, and sends nothing

#### Scenario: Candidate answers sent
- **WHEN** `spec_question` runs with candidates `per-user limits` and `per-IP limits`, `recommended: A` and a rationale
- **THEN** the request has options `A` and `B` with those labels and descriptions, the briefing recommends `A`, and the `## Questions` line holds only the question text

#### Scenario: Too many candidates
- **WHEN** `spec_question` runs with five candidates
- **THEN** the tool refuses and writes nothing

#### Scenario: Candidate label that cannot round-trip
- **WHEN** `spec_question` runs with a candidate labelled `limit --class blocking`
- **THEN** the tool refuses, names the candidate, and writes nothing

### Requirement: Question answers
When a question is answered, the plugin SHALL:
1. rewrite its line to `- [x] Q<n> (<class>): <text> — Answer: <answer>`, keeping every other line byte-identical;
2. write a `question` comment with the class the line holds, the answer, `by`, `at` and the adapter.

Answering a question SHALL NOT untick a unit, write a `stale` comment or move the phase; an answer that needs a requirement change is applied by editing the spec, and the spec edit cascades (see "Spec-diff requirement cascade"). The `question` comment SHALL NOT carry `changes_requirement`; one stored before this change SHALL still be read without error.

The human SHALL NOT set a class when answering; choosing "answer later" in session makes the question non-blocking (approver-adapters "In-session adapter"). With a chain that has no in-session adapter, a question stays blocking until it is answered; an edit of the `(blocking)` marker on the issue web page SHALL still be read as the question's class. A pending question request SHALL take its effective mode from the question's current class. A dismissed question stays open. No gate SHALL open while a blocking question is open.

#### Scenario: Answer written back
- **WHEN** Q1 is answered `use 60s windows`
- **THEN** its line reads `- [x] Q1 (blocking): <text> — Answer: use 60s windows`, it parses back with that answer, and the `question` comment has no `changes_requirement`

#### Scenario: Answer in build changes nothing else
- **WHEN** in `build`, U3 is done, and Q3 is answered
- **THEN** U3 stays ticked, no `stale` comment is written, and the change stays in `build`

#### Scenario: Human reclassifies
- **WHEN** an open blocking Q2 is shown in session with the chain `[in-session, forge]` and the human chooses "answer later"
- **THEN** Q2's line shows `(non-blocking)`, its forge request counts as async, and neither the next step nor `spec_gate` waits for it

### Requirement: Stuck reports
`spec_stuck` SHALL write a `stuck` comment containing:
- where the work stopped;
- what was tried, with links;
- a hypothesis;
- two or three options, each with a description;
- the recommended option and the rationale for it.

It SHALL then send a blocking request with kind `stuck`, those options with their descriptions, and a briefing whose summary is the hypothesis, whose `recommended` is the recommended option and whose `rationale` is the rationale. The hypothesis SHALL follow the briefing `summary` limits. An option without a description, a missing rationale or a hypothesis over the limit MUST be refused before anything is written. A stored report written before descriptions existed SHALL still be sent again when it has no request: each option without a description SHALL get the description `Option <id> of stuck report S<n>.`, and the request SHALL carry a briefing whose summary is the hypothesis, whose `recommended` is the stored recommended option (a stored report always holds one, as "Stuck reports" requires a recommended option) and whose `rationale` is the stored one or, when none is stored, `Recommended in stuck report S<n>.` While a stuck report is unanswered, the next step MUST say to wait for the human's choice, and every gate MUST refuse. The answer SHALL be recorded as a `stuck` answer comment with the outcome, the chosen option, notes, by, at and the adapter; a dismissed answer has outcome `dismissed` and selects no option, recorded as `choice: ""`.

#### Scenario: Stuck report waits for a choice
- **WHEN** `spec_stuck` runs with options A, B and C (A recommended) and the chain is `[forge]`
- **THEN** a `stuck` comment and a pending request are posted, and the next step says to wait for the human's choice

#### Scenario: Option count enforced
- **WHEN** `spec_stuck` runs with one option
- **THEN** the tool refuses and writes nothing

#### Scenario: Choice recorded
- **WHEN** a writer comments `/livespec choose B` on the pending stuck request
- **THEN** a stuck answer comment records choice `B` and the next step no longer waits

#### Scenario: Option without a description
- **WHEN** `spec_stuck` runs with options A and B and B has no description
- **THEN** the tool refuses, names B's description, and writes nothing

#### Scenario: Old stuck report sent again
- **WHEN** stuck report S1, stored without option descriptions or rationale, is open with no request and `spec_stuck` runs
- **THEN** S1's request is sent again with its stored options, each described, and a briefing recommending the stored option with the rationale `Recommended in stuck report S1.`
