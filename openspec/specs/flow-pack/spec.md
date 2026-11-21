# flow-pack Specification

## Purpose

Defines the flow pack: its schema and validation errors with line and column, the default `agent-skills` pack, project overrides, and how packs register sub-schemas and named checks.

## Requirements

### Requirement: Default flow pack
The package SHALL ship the default flow pack `agent-skills` at `src/packs/agent-skills.yaml` with:
- `name: agent-skills`, `version: 1` and `content: agent-skills`;
- the `limits`, `loops`, `decisions` and `init` keys, where `decisions` holds the `tags` and `difficulty` rule config from issue #5, `progress: { mode: rule }` and `finding-scope: { mode: rule }`, each with `mode: rule`;
- the phases `shape`, `define`, `plan`, `build`, `review`, `ship` and `close`, with the skills, outputs, redirects, checks and gates listed in issue #4, plus the `unit-classification` and `verify-red-on-base` checks in `plan`, and the `review-clean` check and the `subagents` entries of review-phase "Reviewer selection" in `review`.

The pack MUST NOT name a model or a lane count.

#### Scenario: Default pack loads
- **WHEN** a project has no `.pi/livespec/flow.yaml`
- **THEN** the loaded pack is `agent-skills` with seven phases in the order `shape`, `define`, `plan`, `build`, `review`, `ship`, `close`, and no validation error

#### Scenario: Default pack contents
- **WHEN** the default pack is loaded
- **THEN** it deep-equals the canonical fixture `tests/fixtures/agent-skills.pack.json`, transcribed from issues #4, #5, #6 and #8, covering `limits`, `loops`, `decisions`, `init.skills` and every phase's `requires`, `per`, skills, outputs, redirects, checks, gate and `subagents`

#### Scenario: Spot check
- **WHEN** the default pack is loaded
- **THEN** phase `define` requires `spec-driven-development`, lists outputs `issue#Capabilities`, `issue#Proposal` and `specs-diff`, checks `spec-format` and `capabilities-match-diff`, and has `gate: human`; phase `build` has `per: unit`; phase `plan` checks `units-format`, `done-maps-scenarios`, `unit-classification` and `verify-red-on-base`; phase `review` checks `review-clean` and has `gate: self`; and `decisions.difficulty.mode`, `decisions.progress.mode` and `decisions.finding-scope.mode` are `rule`

### Requirement: Pack schema validation
The loader SHALL validate a pack against a hand-written schema of the top-level keys `name`, `version`, `content`, `limits`, `loops`, `decisions`, `init`, `phases` and `extends`, and the phase keys `id`, `requires`, `per`, `skills.required`, `skills.optional`, `outputs`, `redirects`, `checks`, `gate` and `subagents`. Every error MUST carry the file, line and column of the offending node, and a YAML syntax error MUST be reported with its line and column.

#### Scenario: Wrong type
- **WHEN** a phase sets `requires: shape` instead of a list
- **THEN** validation returns a type error with that node's line and column

### Requirement: Pack schema rules
The schema MUST reject: unknown keys; `gate` values other than `none`, `self` or `human`; `per` values other than `unit`; duplicate phase ids; `requires` naming an unknown phase; a cycle in `requires`; unregistered check names; outputs other than `issue#Capabilities`, `issue#Proposal`, `issue#Design`, `issue#Units` and `specs-diff`; and keys naming a model or lane count (`model`, `models`, `lanes`, `lane_count`).

#### Scenario: Wrong gate value
- **WHEN** a pack sets `gate: maybe` on a phase at line 12, column 11
- **THEN** validation returns an error naming the file, line 12, column 11 and the allowed values

#### Scenario: Unknown key
- **WHEN** a phase has the key `skils`
- **THEN** validation returns an error with that key's line and column

#### Scenario: Requires cycle
- **WHEN** phase `a` requires `b` and `b` requires `a`
- **THEN** validation returns a cycle error naming both phases

#### Scenario: Model key rejected
- **WHEN** a phase has the key `model`
- **THEN** validation returns an error stating that packs never name models

#### Scenario: YAML syntax error
- **WHEN** the pack file is not valid YAML
- **THEN** validation returns the parser error with its line and column

### Requirement: Invalid pack stops the flow
When the effective pack has any validation error, the system SHALL NOT call `nextStep`, SHALL NOT expose any skill, and every livespec tool that depends on the flow MUST refuse with the list of pack errors. The phase card MUST show only the pack errors.

#### Scenario: Tools refuse
- **WHEN** the project override is invalid and `spec_next` is called
- **THEN** the tool returns an error result listing each pack error with file, line and column, and computes nothing

#### Scenario: No skills exposed
- **WHEN** the effective pack is invalid and pi fires `resources_discover`
- **THEN** no skill path is returned

### Requirement: Project override
A project MAY provide `.pi/livespec/flow.yaml`. When it contains `extends: agent-skills`, the loader SHALL merge it into the default pack:
- a phase whose `id` exists replaces only the keys the override sets;
- a phase with a new `id` is added;
- the maps `limits`, `loops` and `init` merge one level deep;
- `decisions` merges per point, through the merge that the point's registered rule provides, or one level deep when it provides none.

Errors in merged values MUST point at the file that supplied the value.

#### Scenario: Replace one key
- **WHEN** the override sets phase `plan` to `gate: self` only
- **THEN** the effective `plan` phase has `gate: self` and every other key equal to the default

#### Scenario: Replace a skills list
- **WHEN** the override sets phase `review` `skills.optional: [security-and-hardening]`
- **THEN** the effective `review` optional list is exactly `[security-and-hardening]` and `skills.required` is unchanged

#### Scenario: Add a phase
- **WHEN** the override adds phase `docs` with `requires: [review]`
- **THEN** the effective pack has eight phases including `docs`

#### Scenario: Merge loops
- **WHEN** the override sets `loops: { review_rounds: 5 }`
- **THEN** `review_rounds` is 5 and every other loop cap keeps its default

#### Scenario: Error points at override
- **WHEN** the override sets an invalid `gate` value
- **THEN** the error names `.pi/livespec/flow.yaml` and the override's line and column

#### Scenario: Decisions merge through the rule
- **WHEN** the override sets `decisions.tags.keywords.perf: [p99]`
- **THEN** the effective `perf` keywords are the defaults plus `p99`, and `decisions.difficulty` is unchanged

### Requirement: Override limits
An override with `extends` MUST NOT change `name`, `version` or `content`, and `extends` MUST name a known pack. An override without `extends` SHALL be validated and used as a complete pack.

#### Scenario: Unknown extends
- **WHEN** the override has `extends: superpowers`
- **THEN** validation returns an error naming the unknown pack

#### Scenario: Name changed
- **WHEN** an override with `extends: agent-skills` sets `name: mine`
- **THEN** validation returns an error on `name`

#### Scenario: Standalone pack
- **WHEN** the override has no `extends` and defines a valid complete pack with two phases
- **THEN** the effective pack has exactly those two phases

### Requirement: Registration hooks
The loader SHALL let other modules register a validator for the top-level `decisions` value and for the per-phase `subagents` value, and register named checks. A registered validator MUST report its errors with line and column. Before a validator is registered for a key, that key MUST accept only an empty map or an empty list, and a non-empty value MUST be an error.

#### Scenario: Unregistered subagents
- **WHEN** a phase sets a non-empty `subagents` list and no validator is registered for it
- **THEN** validation returns an error stating that no spec has registered `subagents`

#### Scenario: Registered sub-schema
- **WHEN** a test registers a `decisions` validator that rejects key `x`, and the pack sets `decisions: { x: 1 }`
- **THEN** validation returns that validator's error with the line and column of `x`

#### Scenario: Registered check name
- **WHEN** a test registers the check `extra-check` and a phase lists it under `checks`
- **THEN** validation passes
