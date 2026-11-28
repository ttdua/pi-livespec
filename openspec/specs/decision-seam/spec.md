# decision-seam Specification

## Purpose

Defines the decision seam: `decide(point, facts)`, the rule registry and its pack config, decision records on the issue and in small-fix pull request bodies, human overrides, and the `tags` and `difficulty` rules.

## Requirements

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
- **WHEN** the `behavior-change` rule asks for capability `rate-limit`
- **THEN** the request's options `unchanged` and `changed` each carry a description, and its briefing, headed as a livespec rule, recommends `unchanged`

#### Scenario: Rule recommends an option it does not offer
- **WHEN** a test rule asks with options `x` and `y` and recommends `z`
- **THEN** `decide` throws naming `z`

#### Scenario: Rule ask without a recommendation
- **WHEN** a test rule asks with options `x` and `y`, both described, and names no recommendation
- **THEN** `decide` throws naming `recommended`

### Requirement: Rule registry and pack config
`registerRule(point, schema, fn)` SHALL register a rule and the validator for its pack config at `decisions.<point>`. The pack's `decisions` value SHALL be validated with line and column errors:
- an unknown point is an error;
- every point MUST set `mode: rule`;
- `mode: jev` MUST be rejected as reserved for a later version.

#### Scenario: Jev rejected
- **WHEN** the pack sets `decisions.tags.mode: jev`
- **THEN** validation returns an error at that line and column saying `jev` is reserved

#### Scenario: Unknown point
- **WHEN** the pack sets `decisions.nope: { mode: rule }` and no `nope` rule is registered
- **THEN** validation returns an error naming `nope`

### Requirement: Decision records
Every decision of a change SHALL be recorded as a `decision` comment with id `<point>.<subject>` and these YAML fields:
- `point`, `subject`, the unit digest when the subject is a unit, `source`, `outcome` and `reason`;
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

#### Scenario: Behavior files kept with hashed facts
- **WHEN** a `behavior-change` record's facts serialize to more than 2,000 characters of YAML
- **THEN** the record holds `facts_hash`, no `facts`, and the full `files` list

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

### Requirement: Progress rule
The `progress` rule SHALL be registered with `registerRule` and configured as `decisions.progress: { mode: rule }`. Its facts SHALL be built by code from the failed `Verify` run that `unit_finish` captured, never from the agent:
- the attempt number and the cap;
- the failure signature;
- the previous signature in the current attempt budget, when one exists.

The signature SHALL hold two parts:
- the sorted, deduplicated failing test names that can be read from the output (vitest and jest `FAIL`, `go test` `--- FAIL:`, pytest `FAILED`, TAP `not ok`);
- a sha256 hash of the output after ANSI codes, hex runs of seven or more characters, absolute paths, timestamps, durations and other digit runs are normalized and whitespace is collapsed.

The rule MUST return outcome `stop` when either the previous signature equals the current one or the attempt number reached the cap, and `retry` otherwise. It MUST NOT ask a human. Each outcome SHALL be posted as a decision record `progress.U<n>` with the unit digest, and the record SHALL keep the signature and the attempt number readable even when its facts are replaced by `facts_hash`.

#### Scenario: Two identical failures stop early
- **WHEN** U1's first and second post runs fail with the same failing test names and the same normalized output, differing only in timings and temporary paths
- **THEN** the second `progress.U1` record has outcome `stop`, U1 is blocked with reason `progress`, and the attempt count is 2 of 3

#### Scenario: Different failures retry
- **WHEN** U1's first post run fails test `a` and the second fails test `b`
- **THEN** the second `progress.U1` record has outcome `retry`

#### Scenario: Cap with different failures
- **WHEN** the cap is 3 and U1's third failed run has a signature different from the second
- **THEN** the third `progress.U1` record has outcome `stop` and its reason names the cap

#### Scenario: Unrecognized output
- **WHEN** a failed run prints no recognizable test name
- **THEN** the signature has no test names and its hash alone decides equality

#### Scenario: Large output keeps the signature
- **WHEN** a failed run's facts exceed 2,000 characters of yaml
- **THEN** the record holds `facts_hash`, and the next attempt's rule still reads the previous signature

### Requirement: Gate escalation facts
The `gate-escalation` point SHALL be registered with `registerRule` as `decisions.gate-escalation: { mode: rule, phases, tags }` (lists of names; an override replaces each list it sets). Its facts SHALL be built by code, never from the agent:
- `phase` and `head_sha`;
- `failing_waivable`: the phase's failing waivable checks;
- `advisory_review`: `none`, `missing`, `critical` or `clean` (see "Advisory review state");
- `units`: each unit's id and `Tags`.

#### Scenario: Facts from the ledger
- **WHEN** the plan reviewer's completed advisory review covers HEAD with one `WARNING` finding, `size-limits` passes, and U1 is tagged `ui`
- **THEN** the facts are `failing_waivable: []`, `advisory_review: clean` and U1 with tags `[ui]`

#### Scenario: Project adds a tag
- **WHEN** `.pi/livespec/flow.yaml` sets `decisions.gate-escalation.tags: [security, migration, api]` and U1 is tagged `api`
- **THEN** the outcome is `human`

### Requirement: Advisory review state
`advisory_review` SHALL be `none` when the phase has no `always` advisory reviewer entry; otherwise, over every such entry, `missing` when one has no completed review covering HEAD, else `critical` when one's review holds a `CRITICAL` finding, else `clean`. A review run inline and recorded with `subagent_record` SHALL count as completed.

#### Scenario: Second advisory reviewer counted
- **WHEN** a project pack gives `plan` two `always` advisory reviewers, subjects `plan` and `persona:security-auditor`, the `plan` review at HEAD is clean and the persona review at HEAD holds a `CRITICAL` finding
- **THEN** `advisory_review` is `critical`

#### Scenario: One advisory review missing
- **WHEN** the same pack has a clean `plan` review at HEAD and no persona review at HEAD
- **THEN** `advisory_review` is `missing`

### Requirement: Gate escalation rule
The `gate-escalation` rule MUST return `human` when `failing_waivable` is not empty, `advisory_review` is `missing` or `critical`, or a unit has a tag listed in `tags`, with a reason naming every trigger that holds; otherwise it SHALL return `self` with the reason `no trigger`. It MUST NOT ask a human.

#### Scenario: No trigger
- **WHEN** the facts have no failing waivable check, `advisory_review: clean` and units tagged `[ui]` and `[]`
- **THEN** the outcome is `self` with reason `no trigger`

#### Scenario: Every trigger named
- **WHEN** `size-limits` fails, `advisory_review` is `critical` and U3 is tagged `migration`
- **THEN** the outcome is `human` and the reason names `size-limits`, the critical advisory finding and U3's `migration` tag

#### Scenario: Missing advisory review
- **WHEN** the plan phase has its advisory `plan` reviewer and no completed review covers HEAD, and nothing else triggers
- **THEN** the outcome is `human` and the reason names the missing review
