## MODIFIED Requirements

### Requirement: Default flow pack
The package SHALL ship the default flow pack `agent-skills` at `src/packs/agent-skills.yaml` with:
- `name: agent-skills`, `version: 1` and `content: agent-skills`;
- the `limits`, `loops`, `decisions` and `init` keys, where `decisions` holds the `tags` and `difficulty` rule config from issue #5, `progress: { mode: rule }`, `finding-scope: { mode: rule }`, `durable-docs: { mode: rule }`, `lane: { mode: rule, max_files: 3, max_lines: 100 }`, `split: { mode: rule }`, `behavior-change: { mode: rule }`, `drift-severity: { mode: rule }` and `gate-escalation: { mode: rule, phases: [plan], tags: [security, migration] }`, each with `mode: rule`;
- the phases `shape`, `define`, `plan`, `build`, `review`, `ship` and `close`, with the skills, outputs, redirects, checks and gates listed in issue #4, plus the `product-impact`, `glossary-terms` and `behavior-change` checks after the existing checks in `define` and before `review-clean` in `review`, the `unit-classification`, `verify-red-on-base` and `size-limits` checks in `plan`, the `review-clean` check and the `subagents` entries of review-phase "Reviewer selection" in `review`, and the output `issue#Durable docs` and the check `durable-docs` in `ship`.

The pack MUST NOT name a model or a lane count.

#### Scenario: Default pack loads
- **WHEN** a project has no `.pi/livespec/flow.yaml`
- **THEN** the loaded pack is `agent-skills` with seven phases in the order `shape`, `define`, `plan`, `build`, `review`, `ship`, `close`, and no validation error

#### Scenario: Default pack contents
- **WHEN** the default pack is loaded
- **THEN** it deep-equals the canonical fixture `tests/fixtures/agent-skills.pack.json`, transcribed from issues #4, #5, #6, #8, #10, #32, #33, #34 and #65, covering `limits`, `loops`, `decisions`, `init.skills` and every phase's `requires`, `per`, skills, outputs, redirects, checks, gate and `subagents`

#### Scenario: Spot check
- **WHEN** the default pack is loaded
- **THEN** phase `define` requires `spec-driven-development`, lists outputs `issue#Capabilities`, `issue#Proposal` and `specs-diff`, checks `spec-format`, `capabilities-match-diff`, `product-impact`, `glossary-terms` and `behavior-change`, and has `gate: human`; phase `build` has `per: unit`; phase `plan` checks `units-format`, `done-maps-scenarios`, `unit-classification`, `verify-red-on-base` and `size-limits` and has `gate: self`; phase `review` checks `product-impact`, `glossary-terms`, `behavior-change` and `review-clean` and has `gate: self`; phase `ship` lists output `issue#Durable docs`, checks `durable-docs` and has `gate: human`; `decisions.difficulty.mode`, `decisions.progress.mode`, `decisions.finding-scope.mode`, `decisions.durable-docs.mode`, `decisions.lane.mode`, `decisions.split.mode`, `decisions.behavior-change.mode`, `decisions.drift-severity.mode` and `decisions.gate-escalation.mode` are `rule`, `decisions.gate-escalation.phases` is `[plan]`, with `decisions.lane.max_files` 3 and `decisions.lane.max_lines` 100; and `limits` is `{ max_units: 8, max_capabilities: 3 }` and `loops.discovered_deps` is 2

### Requirement: Project override
A project MAY provide `.pi/livespec/flow.yaml`. When it contains `extends: agent-skills`, the loader SHALL merge it into the default pack:
- a phase whose `id` exists replaces only the keys the override sets;
- a phase with a new `id` is added;
- the maps `limits`, `loops` and `init` merge one level deep;
- `decisions` merges per point, through the merge that the point's registered rule provides, or one level deep when it provides none.

Errors in merged values MUST point at the file that supplied the value.

#### Scenario: Replace one key
- **WHEN** the override sets phase `plan` to `gate: human` only
- **THEN** the effective `plan` phase has `gate: human` and every other key equal to the default

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
