# 0005: The flow is YAML data, agent-skills is the default pack

Status: Accepted (2026-11-13)

## Context

The phases, their skills, checks, gates and subagent policy should be adjustable per project without code changes. The method content already exists in agent-skills.

## Decision

- The flow is declared in a YAML flow pack. The default pack is `agent-skills.yaml`. A project can extend or override it in `.pi/livespec/flow.yaml`.
- The `yaml` package (eemeli/yaml) is the only runtime dependency. Packs are validated against a hand-written schema; an invalid pack stops the flow and reports the line and column.
- The plugin manages its own clone of agent-skills from the upstream repository, with automatic upgrades that are compatibility-checked and can be pinned or rolled back.

## Consequences

- The pack never contains models or lane counts. Model choice belongs to the subagent plugin; the lane count is user config.
- Auto-upgrades can change prompt content the user has not read. A `notify` channel exists for users who want to review first.
