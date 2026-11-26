## MODIFIED Requirements

### Requirement: Question tool
`spec_question` SHALL append `- [ ] Q<n> (<class>): <text>` to `## Questions` with the next free number. The class is `blocking` by default, and the agent MAY propose `non-blocking`. The question SHALL then go through the approver with kind `question`: mode `blocking` for blocking questions and `async` for non-blocking ones. `spec_question` with `reask: Q<n>` SHALL send an open question again. The question text MUST be one line.

The agent MAY add two to four candidate answers, each with a label and a description, and MAY recommend one with a rationale (see request-briefing "Briefing shape"). Livespec SHALL give the candidates the option ids `A`, `B`, `C` and `D` in the order given, and `recommended` SHALL name one of those ids. A candidate label MUST be one line with no leading, trailing or repeated whitespace, MUST NOT contain a word starting with `--`, and MUST differ from every other candidate label, so its prefilled `/livespec answer` command parses back to exactly that label. The human SHALL stay free to write any other answer. Candidates SHALL NOT be written into the `## Questions` line. With `reask`, the candidates of the new call SHALL be used.

#### Scenario: Blocking by default
- **WHEN** `spec_question` runs with only text
- **THEN** `## Questions` gains `- [ ] Q<n> (blocking): <text>` and a blocking request is sent

#### Scenario: Non-blocking proposal
- **WHEN** `spec_question` runs with class `non-blocking` and the chain is `[forge]`
- **THEN** the request has mode `async` and the next step does not wait for it

#### Scenario: Candidate answers sent
- **WHEN** `spec_question` runs with candidates `per-user limits` and `per-IP limits`, `recommended: A` and a rationale
- **THEN** the request has options `A` and `B` with those labels and descriptions, the briefing recommends `A`, and the `## Questions` line holds only the question text

#### Scenario: Too many candidates
- **WHEN** `spec_question` runs with five candidates
- **THEN** the tool refuses and writes nothing

#### Scenario: Candidate label that cannot round-trip
- **WHEN** `spec_question` runs with a candidate labelled `limit --class blocking`
- **THEN** the tool refuses, names the candidate, and writes nothing

### Requirement: Stuck reports
`spec_stuck` SHALL write a `stuck` comment containing:
- where the work stopped;
- what was tried, with links;
- a hypothesis;
- two or three options, each with a description;
- the recommended option and the rationale for it.

It SHALL then send a blocking request with kind `stuck`, those options with their descriptions, and a briefing whose summary is the hypothesis, whose `recommended` is the recommended option and whose `rationale` is the rationale. The hypothesis SHALL follow the briefing `summary` limits. An option without a description, a missing rationale or a hypothesis over the limit MUST be refused before anything is written. A stored report written before descriptions existed SHALL still be sent again when it has no request: its options without descriptions, its recommended option only in the summary, and no briefing. While a stuck report is unanswered, the next step MUST say to wait for the human's choice, and every gate MUST refuse. The answer SHALL be recorded as a `stuck` answer comment with the outcome, the chosen option, notes, by, at and the adapter; a dismissed answer has outcome `dismissed` and selects no option, recorded as `choice: ""`.

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
- **THEN** S1's request is sent again with its stored options, its summary names the recommended option, and the request has no briefing
