## MODIFIED Requirements

### Requirement: Default flow pack
The package SHALL ship the default flow pack `agent-skills` at `src/packs/agent-skills.yaml` with:
- `name: agent-skills`, `version: 1` and `content: agent-skills`;
- the `limits`, `loops`, `decisions` and `init` keys, where `decisions` holds the `tags` and `difficulty` rule config from issue #5, `progress: { mode: rule }`, `finding-scope: { mode: rule }`, `durable-docs: { mode: rule }`, `lane: { mode: rule, max_files: 3, max_lines: 100 }`, `split: { mode: rule }`, `behavior-change: { mode: rule }` and `drift-severity: { mode: rule }`, each with `mode: rule`;
- the phases `shape`, `define`, `plan`, `build`, `review`, `ship` and `close`, with the skills, outputs, redirects, checks and gates listed in issue #4, plus the `product-impact`, `glossary-terms` and `behavior-change` checks after the existing checks in `define` and before `review-clean` in `review`, the `unit-classification`, `verify-red-on-base` and `size-limits` checks in `plan`, the `review-clean` check and the `subagents` entries of review-phase "Reviewer selection" in `review`, and the output `issue#Durable docs` and the check `durable-docs` in `ship`.

The pack MUST NOT name a model or a lane count.

#### Scenario: Default pack loads
- **WHEN** a project has no `.pi/livespec/flow.yaml`
- **THEN** the loaded pack is `agent-skills` with seven phases in the order `shape`, `define`, `plan`, `build`, `review`, `ship`, `close`, and no validation error

#### Scenario: Default pack contents
- **WHEN** the default pack is loaded
- **THEN** it deep-equals the canonical fixture `tests/fixtures/agent-skills.pack.json`, transcribed from issues #4, #5, #6, #8, #10, #32, #33 and #34, covering `limits`, `loops`, `decisions`, `init.skills` and every phase's `requires`, `per`, skills, outputs, redirects, checks, gate and `subagents`

#### Scenario: Spot check
- **WHEN** the default pack is loaded
- **THEN** phase `define` requires `spec-driven-development`, lists outputs `issue#Capabilities`, `issue#Proposal` and `specs-diff`, checks `spec-format`, `capabilities-match-diff`, `product-impact`, `glossary-terms` and `behavior-change`, and has `gate: human`; phase `build` has `per: unit`; phase `plan` checks `units-format`, `done-maps-scenarios`, `unit-classification`, `verify-red-on-base` and `size-limits`; phase `review` checks `product-impact`, `glossary-terms`, `behavior-change` and `review-clean` and has `gate: self`; phase `ship` lists output `issue#Durable docs`, checks `durable-docs` and has `gate: human`; `decisions.difficulty.mode`, `decisions.progress.mode`, `decisions.finding-scope.mode`, `decisions.durable-docs.mode`, `decisions.lane.mode`, `decisions.split.mode`, `decisions.behavior-change.mode` and `decisions.drift-severity.mode` are `rule`, with `decisions.lane.max_files` 3 and `decisions.lane.max_lines` 100; and `limits` is `{ max_units: 8, max_capabilities: 3 }` and `loops.discovered_deps` is 2

