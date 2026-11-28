## MODIFIED Requirements

### Requirement: Forge request text
The plain text below the yaml of a forge `request` comment SHALL contain, in this order:
1. a heading that states the decision needed, naming the subject and the change;
2. the facts: the request summary, then the files and links;
3. a checks table when the request lists failing waivable checks;
4. the briefing, when there is one;
5. a "How to answer" table with one row per offered choice, giving its description and the exact command to post, the recommended one first and marked; for a question, a candidate's command is `/livespec answer Q<n> <label>`, and one more row always gives the free-text form `/livespec answer Q<n> <text>`;
6. the full list of accepted commands inside a collapsed `<details>` block; for a request with `overridableBehavior` (approver-adapters "Behavior overrides"), the list SHALL include `/livespec set behavior <capability> changed` with a note that it applies only together with `/livespec changes <notes>`.

Livespec-written text SHALL be English. The parser SHALL keep ignoring this text, and this text MUST NOT change the command grammar of approver-adapters "Forge command comments".

#### Scenario: Gate comment structure
- **WHEN** `spec_gate define` sends a forge request with a briefing recommending `approve`
- **THEN** the comment shows a "Decision needed" heading, the Proposal and spec diff facts, the briefing, and a "How to answer" table whose `approve` row is marked recommended and shows `/livespec approve`

#### Scenario: Question candidates as commands
- **WHEN** `spec_question` sends Q2 with candidates `per-user limits` and `per-IP limits` on the forge
- **THEN** the "How to answer" table has a row with `/livespec answer Q2 per-user limits` and a row with `/livespec answer Q2 per-IP limits`

#### Scenario: Prefilled answer parses back
- **WHEN** a writer posts the prefilled command of candidate `per-user limits` for Q2
- **THEN** Q2 is answered exactly `per-user limits`

#### Scenario: Behavior override command listed
- **WHEN** a forge `gate:define` request is sent for a change with behavior item `rate-limit`
- **THEN** the `<details>` list holds `/livespec set behavior <capability> changed` and says it applies only with `/livespec changes`

#### Scenario: Recommended row first
- **WHEN** a stuck request with options A and B, B recommended, is rendered for the forge
- **THEN** the first row of the "How to answer" table is B, marked recommended

