## Why

After compaction or in a new session, the agent forgets where a change stands and skips steps. LS-02 gave us the formats and LS-03 the forge, but nothing yet reads them to say "you are here, do this next", and the agent-skills method content is not wired in. LS-04 (issue #4) makes the flow run: state is derived from the issue and git every turn, never from memory.

## What Changes

- Add the YAML flow pack: the default pack `src/packs/agent-skills.yaml`, a hand-written schema with line and column errors, project overrides in `.pi/livespec/flow.yaml` (`extends: agent-skills`), and registration hooks for sub-schemas (`decisions`, `subagents`) and named checks.
- Add the engine: a `changeState` snapshot built from the change issue and git, a pure `nextStep(pack, changeState)`, the named checks `spec-format`, `units-format`, `done-maps-scenarios` and `capabilities-match-diff` over the LS-02 validators, `counter` and `skill-note` comments, `advancePhase`, and the integration branch rule.
- Add agent-skills content management: a clone under `~/.pi/agent/livespec/agent-skills/<sha>/` with a `current` symlink and `livespec.lock`, skill exposure through `resources_discover` (pack skills only, initialized projects only, never `using-agent-skills` or `context-engineering`), compatibility-checked upgrades on the `auto`, `notify` and `pinned` channels, and `/livespec skills status | update | pin <sha> | unpin | rollback`.
- Add `/livespec init` (idempotent) and `/livespec doctor` (report only), including a suggestion of `/livespec migrate-openspec` for an uninitialized project with an `openspec/` folder.
- Add context injection: a static routing note at the start of the context and a phase card appended at the end of the messages and replaced each turn, plus resume at session start.
- Add the tools `spec_status`, `spec_next` (also `/livespec next`), `skill_note`, `spec_write`, `change_new` and `change_start`.
- Update `docs/architecture.md` (engine and content). Record a manual 5-turn cache smoke run in the change.

Out of scope: gates and approvals (LS-05), running `Verify` and receipts (LS-06), subagents (LS-07), and the checks of other phases.

## Capabilities

### New Capabilities
- `flow-pack`: pack schema and validation with line and column, the default `agent-skills` pack, project overrides, and registration of sub-schemas and named checks.
- `flow-engine`: the `changeState` snapshot, `nextStep`, the LS-02 named checks, loop counters, skill notes, `advancePhase` and the integration branch.
- `agent-skills-content`: the agent-skills clone, lock file, skill exposure, upgrade channels with compatibility checks, and the `/livespec skills` subcommands.
- `init-and-doctor`: `/livespec init`, `/livespec doctor` and the project and user config files.
- `context-injection`: the routing note, the phase card and resume at session start.
- `change-tools`: `spec_status`, `spec_next`, `/livespec next`, `skill_note`, `spec_write`, `change_new` and `change_start`.

### Modified Capabilities

None. `package-scaffold` already leaves subcommands to their own capabilities, and its dependency policy (only `yaml`) still holds. `spec-validation`, `change-issue-format`, `forge-*` and `openspec-migration` are consumed unchanged.

## Impact

- New code under `src/engine/`, `src/content/`, `src/hooks/`, `src/commands/`, `src/tools/` and `src/packs/`, one new pure helper in `src/core/`, and wiring in `src/extension.ts`. New tests under `tests/`.
- No new runtime dependency. The clone and branch operations run the `git` binary, which the project brief already requires.
- The extension now builds a `Forge` at session start (through `detectForge` and `CachedForge`) and touches `~/.pi/agent/livespec/` (clone, lock, cache).
- `docs/architecture.md` gains the engine and content details.
