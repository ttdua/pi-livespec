## MODIFIED Requirements

### Requirement: Briefing shape
Every request SHALL carry a briefing (approver-adapters "Interaction contract"), with:
- `summary`: required, at most 600 characters, with no blank line;
- `watch`: zero to five points to check, each one line of at most 200 characters;
- `recommended`: the id of one offered choice, required;
- `rationale`: at most 600 characters with no blank line, required.

The offered choices of a gate or amendment request SHALL be its built-in actions (`approve`, `changes`, `dismiss`, and `waive` when offered) plus its options; for other requests they SHALL be the request's options. Every option SHALL carry a `description`, one line of at most 200 characters. A stored request MAY lack the briefing or option descriptions. Lengths SHALL be counted in Unicode code points.

#### Scenario: Recommended choice not offered
- **WHEN** `spec_stuck` runs with options A and B and `recommended: C`
- **THEN** the tool refuses, names `recommended` and the offered ids, and writes nothing

#### Scenario: Rationale missing
- **WHEN** `spec_gate define` runs with a briefing that sets `recommended: approve` and no `rationale`
- **THEN** the tool refuses, names `rationale`, and sends no request

#### Scenario: Summary too long
- **WHEN** a briefing `summary` has 601 characters
- **THEN** the sending tool refuses and names `summary` and the 600-character limit

#### Scenario: Recommendation missing
- **WHEN** `unit_amend U1` runs with a valid replacement and a briefing with only a `summary`
- **THEN** the tool refuses, names `recommended`, and sends no request

### Requirement: Forge request text
The plain text below the yaml of a forge `request` comment SHALL contain, in this order:
1. a heading that states the decision needed, naming the subject and the change;
2. the facts: the request summary, then the files and links;
3. a checks table when the request lists failing waivable checks;
4. the briefing, when there is one;
5. a "How to answer" table with one row per offered choice, giving its description and the exact command to post, the recommended one first and marked; for a question, a candidate's command is `/livespec answer Q<n> <label>`, and one more row always gives the free-text form `/livespec answer Q<n> <text>`;
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

#### Scenario: Recommended row first
- **WHEN** a stuck request with options A and B, B recommended, is rendered for the forge
- **THEN** the first row of the "How to answer" table is B, marked recommended
