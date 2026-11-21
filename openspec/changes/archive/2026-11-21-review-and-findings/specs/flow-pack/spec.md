## MODIFIED Requirements

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
