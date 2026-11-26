# questions-and-stuck Specification

## Purpose

Defines `spec_question` and the Questions ledger, answers and the cascade when an answer changes a requirement, the `change_iterations` cap, and `spec_stuck` reports.

## Requirements

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

### Requirement: Question answers
When a question is answered, the plugin SHALL:
1. rewrite its line to `- [x] Q<n> (<class>): <text> — Answer: <answer>`, keeping every other line byte-identical, except the status lines that a cascade unticks;
2. write a `question` comment with the class, the answer, `changes_requirement`, `by`, `at` and the adapter.

The human MAY change the class when answering, or before answering with `/livespec class`. A pending question request SHALL take its effective mode from the question's current class. A dismissed question stays open. No gate SHALL open while a blocking question is open.

#### Scenario: Answer written back
- **WHEN** Q1 is answered `use 60s windows` without a requirement change
- **THEN** its line reads `- [x] Q1 (blocking): <text> — Answer: use 60s windows` and parses back with that answer

#### Scenario: Human reclassifies
- **WHEN** a writer comments `/livespec class Q2 non-blocking` on an open blocking Q2
- **THEN** Q2's line shows `(non-blocking)`, its pending request counts as async, and neither the next step nor `spec_gate` waits for it

### Requirement: Requirement cascade
When an answer changes a requirement, the plugin SHALL:
1. move the change back to `define` when it is past define;
2. write a `stale` comment that names the question, `define` and every phase after it, and the units whose `Covers` names that requirement;
3. untick the stale units that are done, using `untickUnit`.

While a lock exists, stale units MUST need an amendment before the plan gate opens again. A unit made stale before the first lock SHALL instead be cleared by the first plan approval (see unit-planning "Re-planning after the lock"). The `change_iterations` count SHALL be the number of cascades that moved the change back to define from a later phase after a plan gate was approved. It is derived from own `stale` comments, so retrying a completion never counts twice. Completion MUST be idempotent: retrying a partly applied cascade SHALL finish the missing effects without repeating the applied ones.

#### Scenario: Answer sends the change back
- **WHEN** in `build`, Q3's answer changes `rate-limit/Requirement: Per-IP cap`, U3 covers it and is done, and U1 does not cover it
- **THEN** the change is in `define`, U3 is unticked and stale, U1 is unchanged, and `change_iterations` is 1

#### Scenario: Cascade before the plan
- **WHEN** in `define`, an answer changes a requirement and no plan gate was ever approved
- **THEN** a `stale` comment is written and `change_iterations` is not incremented

#### Scenario: Second answer while in define
- **WHEN** after a counted return to define, a second answer in `define` changes another requirement
- **THEN** a second `stale` comment is written and `change_iterations` does not rise

#### Scenario: Retried cascade counts once
- **WHEN** a cascade's body write and `stale` comment succeed, the phase move fails, and the next poll completes the answer
- **THEN** the change is in `define`, exactly one `stale` comment exists for the question, and `change_iterations` rose by one

### Requirement: Iteration cap
The cap SHALL block when `change_iterations` is at least `loops.change_iterations` and no stuck report was answered with a chosen option after the latest counted cascade. While it blocks, the next step SHALL ask for a stuck report, and every gate MUST refuse. A stuck answer with outcome `approved` or `approved_with_notes` and a choice SHALL lift the block until the next counted cascade. A dismissed stuck answer MUST NOT lift the block.

#### Scenario: Cap reached
- **WHEN** `change_iterations` is 5 with cap 5 and no stuck answer follows it
- **THEN** the next step asks to send a stuck report with `spec_stuck` and `spec_gate define` refuses

#### Scenario: Stuck answer lifts the cap
- **WHEN** `change_iterations` is 5 with cap 5 and a stuck report was answered after the fifth cascade with outcome `approved` and choice `B`
- **THEN** the next step no longer asks for a stuck report, and a sixth cascade blocks again

#### Scenario: Dismissed stuck answer keeps the cap
- **WHEN** `change_iterations` is 5 with cap 5 and the only stuck report after the fifth cascade was dismissed
- **THEN** the next step asks for a new stuck report and `spec_gate define` refuses

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
