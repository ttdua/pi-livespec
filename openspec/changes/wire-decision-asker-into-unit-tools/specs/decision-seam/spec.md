## MODIFIED Requirements

### Requirement: Decision seam
`decide(point, facts)` SHALL run the rule registered for `point` and return `{ outcome, source, reason, facts }`. Facts MUST come from code (paths, parsed issue fields, config), never from the agent's own account. A rule MAY return `ask` with options. `decide` SHALL then send the options through the approver, and an answer SHALL give `source: human`. A pending answer SHALL return `pending` with the request id. An unregistered point MUST throw.

When the subject is a unit, the ask SHALL carry the unit's current digest, and the `decision` record of the human answer SHALL hold that digest. Before asking, the approver SHALL take the latest record for `<point>.<subject>` with that digest, whatever its source, and SHALL reuse it instead of asking again only when it has source `human`, the same facts (or `facts_hash`) and an outcome that is not `null`; an older record is never consulted when the latest one does not qualify, so a reused answer is always the record the unit's classification is checked against; `decide` then returns that outcome with source `human`. A dismissed answer (outcome `null`) MUST NOT be reused, and a record for another digest or other facts MUST NOT be reused. A rule that decides without asking MUST NOT be replaced by a recorded human answer.

#### Scenario: Rule outcome
- **WHEN** `decide("difficulty", facts)` runs for a unit with one file and no tags
- **THEN** it returns outcome `low`, source `rule` and a reason naming the facts used

#### Scenario: Rule asks
- **WHEN** a test rule returns `ask` with options `x` and `y` and the human selects `y` in session
- **THEN** `decide` returns outcome `y` with source `human`

#### Scenario: Human record carries the unit digest
- **WHEN** a test rule asks for unit U1 and the human answers `y` with `/livespec choose y`
- **THEN** the `decision` record `<point>.U1` has source `human`, outcome `y` and U1's current digest

#### Scenario: Recorded answer reused
- **WHEN** a human record `y` exists for U1's current digest and the same facts, and the rule asks again
- **THEN** `decide` returns outcome `y` with source `human` and no request is sent

#### Scenario: Changed facts ask again
- **WHEN** a human record exists for U1's current digest but the rule now asks with other facts
- **THEN** a new request is sent

#### Scenario: Changed contract asks again
- **WHEN** a human record exists for U1 with the same facts but an older digest
- **THEN** a new request is sent

#### Scenario: Dismissed answer not reused
- **WHEN** a human record `y` for U1's current digest and facts is followed by a newer human record for the same digest with outcome `null`
- **THEN** a new request is sent

#### Scenario: Latest human record wins
- **WHEN** two human records for U1's current digest exist, the older with the current facts and outcome `x`, the newer with other facts and outcome `y`
- **THEN** no answer is reused and a new request is sent

#### Scenario: Newer rule record stops reuse
- **WHEN** a human record `y` for U1's current digest and facts F is followed by a rule record for the same digest, and the rule asks again with facts F
- **THEN** no answer is reused and a new request is sent

#### Scenario: Large facts reused by hash
- **WHEN** a human record for U1's current digest holds `facts_hash` because its facts exceed 2,000 characters of YAML, and the rule asks again with the same facts
- **THEN** the recorded outcome is reused and no request is sent

#### Scenario: Rule decision ignores a human record
- **WHEN** a human record `y` exists for U1's current digest and facts and the rule now decides `x` without asking
- **THEN** `decide` returns `x` with source `rule`

#### Scenario: Changed tags change the difficulty question
- **WHEN** a human answered `difficulty.U1` for tags `[]` and U1, with the same digest, is now tagged `[ui]`, and the `difficulty` rule asks
- **THEN** a new request is sent, because the facts include the tags

