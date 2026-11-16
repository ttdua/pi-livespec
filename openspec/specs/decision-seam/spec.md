# decision-seam Specification

## Purpose

Defines the decision seam: `decide(point, facts)`, the rule registry and its pack config, decision records on the issue and in small-fix pull request bodies, human overrides, and the `tags` and `difficulty` rules.

## Requirements

### Requirement: Decision seam
`decide(point, facts)` SHALL run the rule registered for `point` and return `{ outcome, source, reason, facts }`. Facts MUST come from code (paths, parsed issue fields, config), never from the agent's own account. A rule MAY return `ask` with options. `decide` SHALL then send the options through the approver, and an answer SHALL give `source: human`. A pending answer SHALL return `pending` with the request id. An unregistered point MUST throw.

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

### Requirement: Rule registry and pack config
`registerRule(point, schema, fn)` SHALL register a rule and the validator for its pack config at `decisions.<point>`. The pack's `decisions` value SHALL be validated with line and column errors:
- an unknown point is an error;
- every point MUST set `mode: rule`;
- `mode: jev` MUST be rejected as reserved for a later version.

#### Scenario: Jev rejected
- **WHEN** the pack sets `decisions.tags.mode: jev`
- **THEN** validation returns an error at that line and column saying `jev` is reserved

#### Scenario: Unknown point
- **WHEN** the pack sets `decisions.lane: { mode: rule }` and no `lane` rule is registered
- **THEN** validation returns an error naming `lane`

### Requirement: Decision records
Every decision SHALL be recorded as a `decision` comment with id `<point>.<subject>` and these YAML fields:
- `point`, `subject`, the unit digest when the subject is a unit, `source`, `outcome` and `reason`;
- `facts`, or `facts_hash` when the facts' YAML exceeds 2,000 characters;
- `agent_additions`;
- `overridden_by`.

The latest record for an id SHALL win, except that a record with `proposal: true` MUST NOT count as the current decision of a unit (for the `unit-classification` check and gate payloads); it only serves the reuse of an answer. Only tools MUST write outcomes into the issue body.

#### Scenario: Record fields
- **WHEN** `plan_units` writes U3 with tags `[security, api]` where the agent added `api`
- **THEN** the `decision` comment `tags.U3` has source `rule`, outcome `[security, api]` and `agent_additions: [api]`

#### Scenario: Large facts hashed
- **WHEN** a decision's facts serialize to more than 2,000 characters of YAML
- **THEN** the record holds `facts_hash` and no `facts`

#### Scenario: Proposal record is not current
- **WHEN** `difficulty.U1` has a rule record `low` for U1's digest followed by a human record `high` with `proposal: true` for the same digest
- **THEN** the current `difficulty` decision of U1 is the rule record `low`

### Requirement: Small-fix decision block
The system SHALL define the small-fix pull request body format for decision records: a block whose first line is `<!-- livespec:decision:<point> -->`, followed by one fenced `yaml` block with the decision record fields. It SHALL provide a formatter and a parser that round-trip the block and ignore the rest of the body.

#### Scenario: Round trip in a PR body
- **WHEN** a decision block for `lane` is formatted into a body with other text and parsed back
- **THEN** the parser returns one record for `lane` with the same fields

### Requirement: Human override of classification
At an approved plan gate or amendment gate, the human MAY change a unit's `Difficulty` or `Tags`. The plugin SHALL then:
1. rewrite only that unit's line in the body;
2. post a new decision record with source `human`, the new outcome, and `overridden_by` holding who, when, and the previous outcome.

The agent MUST NOT be able to remove a rule-assigned tag or change `Difficulty`.

#### Scenario: Override recorded
- **WHEN** at the plan gate the human sets U2 difficulty to `high`, overriding `medium`, and approves
- **THEN** U2 reads `Difficulty: high` and the `difficulty.U2` record has source `human` with `overridden_by` naming the human and `medium`

#### Scenario: Agent cannot remove a tag
- **WHEN** `plan_units` runs with `extra_tags` for a unit that the rule tags `security`
- **THEN** the written tags contain `security`, because `extra_tags` can only add

### Requirement: Tags rule
The `tags` rule SHALL tag a unit when any of its `Files` matches a glob of that tag (`matchGlob`), or when its title, `Covers` or `Done means` text contains a keyword of that tag as a whole word or phrase, ignoring case. The default config in the pack SHALL be:
- paths:
  - `security`: `**/auth/**`, `**/middleware/**`
  - `migration`: `**/migrations/**`
  - `ui`: `**/*.tsx`, `**/*.jsx`, `**/*.css`, `**/*.vue`, `**/*.svelte`
  - `api`: `**/api/**`, `**/routes/**`
- keywords:
  - `security`: auth, token, password, session, permission, secret
  - `migration`: migration, schema
  - `perf`: performance, latency, throughput, cache
  - `api`: endpoint, public api

Agent `extra_tags` SHALL be appended without duplicates and listed in `agent_additions`. `framework` and `critical-path` have no default mapping.

#### Scenario: Path match
- **WHEN** a unit lists `db/migrations/0003.sql`
- **THEN** it is tagged `migration`

#### Scenario: Keyword whole word
- **WHEN** a unit's Done means says "store the author name" and nothing else matches
- **THEN** it is not tagged `security`

#### Scenario: Keyword phrase ignoring case
- **WHEN** a unit's title is "Document the Public API"
- **THEN** it is tagged `api`

### Requirement: Tags project override
A project override of `decisions.tags` SHALL merge per tag: its globs and keywords are added to the defaults for that tag, without duplicates. A new tag is added.

#### Scenario: Override adds globs
- **WHEN** `.pi/livespec/flow.yaml` sets `decisions.tags.paths.security: ["**/crypto/**"]`
- **THEN** the effective `security` globs are `**/auth/**`, `**/middleware/**` and `**/crypto/**`

### Requirement: Difficulty rule
The `difficulty` rule SHALL return:
- `high` when the unit has tag `security` or `migration`, covers more than one distinct capability, or has more than 4 `Files`;
- otherwise `low` when it has exactly one file and no tags;
- otherwise `medium`.

#### Scenario: Two capabilities
- **WHEN** a unit covers `rate-limit/Requirement: A` and `auth/Requirement: B`
- **THEN** its difficulty is `high`

#### Scenario: Medium default
- **WHEN** a unit has two files and tag `ui`
- **THEN** its difficulty is `medium`
