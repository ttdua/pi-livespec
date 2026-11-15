## ADDED Requirements

### Requirement: Decision seam
`decide(point, facts)` SHALL run the rule registered for `point` and return `{ outcome, source, reason, facts }`. Facts MUST come from code (paths, parsed issue fields, config), never from the agent's own account. A rule MAY return `ask` with options. `decide` SHALL then send the options through the approver, and an answer SHALL give `source: human`. A pending answer SHALL return `pending` with the request id. An unregistered point MUST throw.

#### Scenario: Rule outcome
- **WHEN** `decide("difficulty", facts)` runs for a unit with one file and no tags
- **THEN** it returns outcome `low`, source `rule` and a reason naming the facts used

#### Scenario: Rule asks
- **WHEN** a test rule returns `ask` with options `x` and `y` and the human selects `y` in session
- **THEN** `decide` returns outcome `y` with source `human`

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

The latest record for an id SHALL win. Only tools MUST write outcomes into the issue body.

#### Scenario: Record fields
- **WHEN** `plan_units` writes U3 with tags `[security, api]` where the agent added `api`
- **THEN** the `decision` comment `tags.U3` has source `rule`, outcome `[security, api]` and `agent_additions: [api]`

#### Scenario: Large facts hashed
- **WHEN** a decision's facts serialize to more than 2,000 characters of YAML
- **THEN** the record holds `facts_hash` and no `facts`

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
