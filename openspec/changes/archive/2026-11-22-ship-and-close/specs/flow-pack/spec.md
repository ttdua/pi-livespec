## MODIFIED Requirements

### Requirement: Default flow pack
The package SHALL ship the default flow pack `agent-skills` at `src/packs/agent-skills.yaml` with:
- `name: agent-skills`, `version: 1` and `content: agent-skills`;
- the `limits`, `loops`, `decisions` and `init` keys, where `decisions` holds the `tags` and `difficulty` rule config from issue #5, `progress: { mode: rule }`, `finding-scope: { mode: rule }` and `durable-docs: { mode: rule }`, each with `mode: rule`;
- the phases `shape`, `define`, `plan`, `build`, `review`, `ship` and `close`, with the skills, outputs, redirects, checks and gates listed in issue #4, plus the `unit-classification` and `verify-red-on-base` checks in `plan`, the `review-clean` check and the `subagents` entries of review-phase "Reviewer selection" in `review`, and the output `issue#Durable docs` and the check `durable-docs` in `ship`.

The pack MUST NOT name a model or a lane count.

#### Scenario: Default pack loads
- **WHEN** a project has no `.pi/livespec/flow.yaml`
- **THEN** the loaded pack is `agent-skills` with seven phases in the order `shape`, `define`, `plan`, `build`, `review`, `ship`, `close`, and no validation error

#### Scenario: Default pack contents
- **WHEN** the default pack is loaded
- **THEN** it deep-equals the canonical fixture `tests/fixtures/agent-skills.pack.json`, transcribed from issues #4, #5, #6, #8 and #32, covering `limits`, `loops`, `decisions`, `init.skills` and every phase's `requires`, `per`, skills, outputs, redirects, checks, gate and `subagents`

#### Scenario: Spot check
- **WHEN** the default pack is loaded
- **THEN** phase `define` requires `spec-driven-development`, lists outputs `issue#Capabilities`, `issue#Proposal` and `specs-diff`, checks `spec-format` and `capabilities-match-diff`, and has `gate: human`; phase `build` has `per: unit`; phase `plan` checks `units-format`, `done-maps-scenarios`, `unit-classification` and `verify-red-on-base`; phase `review` checks `review-clean` and has `gate: self`; phase `ship` lists output `issue#Durable docs`, checks `durable-docs` and has `gate: human`; and `decisions.difficulty.mode`, `decisions.progress.mode`, `decisions.finding-scope.mode` and `decisions.durable-docs.mode` are `rule`

### Requirement: Pack schema rules
The schema MUST reject: unknown keys; `gate` values other than `none`, `self` or `human`; `per` values other than `unit`; duplicate phase ids; `requires` naming an unknown phase; a cycle in `requires`; unregistered check names; outputs other than `issue#Capabilities`, `issue#Proposal`, `issue#Design`, `issue#Units`, `issue#Durable docs` and `specs-diff`; and keys naming a model or lane count (`model`, `models`, `lanes`, `lane_count`).

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

#### Scenario: Durable docs output accepted
- **WHEN** a phase lists output `issue#Durable docs`
- **THEN** validation returns no error for it
