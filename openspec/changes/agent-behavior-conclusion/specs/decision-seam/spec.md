## MODIFIED Requirements

### Requirement: Decision seam
`decide(point, facts)` SHALL run the rule registered for `point` and return `{ outcome, source, reason, facts }`. Facts MUST come from code (paths, parsed issue fields, config), never from the agent's own account. A rule MAY return `ask` with options. Each option MUST carry a description, and the ask MUST name a recommended option with a rationale (approver-adapters "Interaction contract"); these SHALL come from the rule, never from the agent. A rule ask without a recommendation, without a rationale, with an option without a description, or recommending an option it does not offer MUST make `decide` throw. Scenarios in any spec where a test rule asks, or where a built-in rule that never asks (such as `difficulty`) is said to ask, SHALL be read as a test rule registered under that name that describes its options and names `recommended` and `rationale`, unless they say otherwise. `decide` SHALL then send the options through the approver, with a briefing built from the rule, and an answer SHALL give `source: human`. A pending answer SHALL return `pending` with the request id. An unregistered point MUST throw.

When the subject is a unit, the ask SHALL carry the unit's current digest, and the `decision` record of the human answer SHALL hold that digest. An ask MAY be a proposal (an amendment not yet approved); the human record of a proposal's answer SHALL hold `proposal: true`. Before asking, the approver SHALL take the latest record for `<point>.<subject>` with that digest, whatever its source and including proposal records, and SHALL reuse it instead of asking again only when it has source `human`, the same facts (or `facts_hash`) and an outcome that is not `null`; an older record is never consulted when the latest one does not qualify, so a reused answer is never older than the latest decision for that contract; `decide` then returns that outcome with source `human`. A dismissed answer (outcome `null`) MUST NOT be reused, and a record for another digest or other facts MUST NOT be reused. A rule that decides without asking MUST NOT be replaced by a recorded human answer.

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

#### Scenario: Rule ask carries descriptions
- **WHEN** a test rule asks with options `x` and `y`, both described, recommending `x` with a rationale
- **THEN** the request's options `x` and `y` each carry their description, and its briefing, headed as a livespec rule, recommends `x`

#### Scenario: Rule recommends an option it does not offer
- **WHEN** a test rule asks with options `x` and `y` and recommends `z`
- **THEN** `decide` throws naming `z`

#### Scenario: Rule ask without a recommendation
- **WHEN** a test rule asks with options `x` and `y`, both described, and names no recommendation
- **THEN** `decide` throws naming `recommended`

### Requirement: Decision records
Every decision of a change SHALL be recorded as a `decision` comment with id `<point>.<subject>` and these YAML fields:
- `point`, `subject`, the unit digest when the subject is a unit, `source`, `outcome` and `reason`; `source` SHALL be `rule` or `human`, and for point `behavior-change` also `agent` or `reviewer`; a record of another point with source `agent` or `reviewer` MUST be invalid;
- `facts`, or `facts_hash` when the facts' YAML exceeds 2,000 characters;
- for point `behavior-change`, `files`: the item's files, kept when `facts` becomes `facts_hash`;
- `agent_additions`;
- `overridden_by`.

The latest record for an id SHALL win, except that a record with `proposal: true` MUST NOT count as the current decision of a unit (for the `unit-classification` check and gate payloads); it only serves the reuse of an answer. Only tools MUST write outcomes into the issue body. A `lane` decision on a fix branch, which has no issue, SHALL be recorded only as the pull request body block of "Small-fix decision block" when `fix_ship` opens or updates the pull request; a `lane` outcome shown on the fix card is not recorded.

#### Scenario: Record fields
- **WHEN** `plan_units` writes U3 with tags `[security, api]` where the agent added `api`
- **THEN** the `decision` comment `tags.U3` has source `rule`, outcome `[security, api]` and `agent_additions: [api]`

#### Scenario: Large facts hashed
- **WHEN** a decision's facts serialize to more than 2,000 characters of YAML
- **THEN** the record holds `facts_hash` and no `facts`

#### Scenario: Lane decision in the pull request only
- **WHEN** `fix_ship` opens a pull request for `fix/typo`
- **THEN** the `lane` record is in the pull request body and no `decision` comment is written to any issue

#### Scenario: Proposal record is not current
- **WHEN** `difficulty.U1` has a rule record `low` for U1's digest followed by a human record `high` with `proposal: true` for the same digest
- **THEN** the current `difficulty` decision of U1 is the rule record `low`

#### Scenario: Agent source only for behavior-change
- **WHEN** an own `decision` comment `difficulty.U1` has source `agent`
- **THEN** it is invalid and not read as a decision, while a `behavior-change.rate-limit` record with source `agent` is valid

#### Scenario: Behavior files kept with hashed facts
- **WHEN** a `behavior-change` record's facts serialize to more than 2,000 characters of YAML
- **THEN** the record holds `facts_hash`, no `facts`, and the full `files` list

