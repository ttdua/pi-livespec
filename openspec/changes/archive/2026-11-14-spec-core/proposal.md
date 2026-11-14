## Why

Every later pi-livespec spec reads or writes the durable `specs/` files and the change and initiative issue bodies. Without one shared, tested implementation, each later spec would invent its own parsing and drift. Pure functions over text can be tested exhaustively, so the formats are fixed first.

## What Changes

- Add pure parsers, serializers and validators for the living spec, decision, glossary and bare-work files, and for change and initiative issue bodies. Parse then serialize returns the same bytes.
- Add `unitDigest`, `tickUnit`/`untickUnit`, `tickChange`/`untickChange`, `matchGlob` and `capabilitiesMatchDiff`.
- Add `/livespec validate` and a `spec_validate` tool over `specs/`.
- Add `/livespec migrate-openspec`, which moves `openspec/specs/<cap>/spec.md` to `specs/<cap>/spec.md`.

**Version command**
- From: `/livespec` prints the version and "SHALL perform no other action".
- To: bare `/livespec` still only prints the version; the subcommands `validate` and `migrate-openspec` perform their own actions.
- Reason: the two new commands need a home under the existing command.
- Impact: non-breaking. The "Command prints the version" scenario is kept; "Command has no side effects" is narrowed to the bare command.

## Capabilities

### New Capabilities
- `spec-formats`: parse and serialize living specs, decisions, glossary and bare-work files; `matchGlob`.
- `change-issue-format`: parse and serialize change and initiative bodies; unit fields, unit digest, tick and untick.
- `spec-validation`: validators and the validation result; `capabilities-match-diff`; `/livespec validate` and `spec_validate`.
- `openspec-migration`: `/livespec migrate-openspec`.

### Modified Capabilities
- `package-scaffold`: the Version command requirement allows subcommands.

## Impact

- New code under `src/core/` (pure) and `src/commands/` (I/O); `src/extension.ts` dispatches subcommands and registers `spec_validate`.
- No new runtime dependency (`yaml` is reused). `docs/architecture.md` is updated only if a format changes; none is expected.
- Out of scope: forge reads (LS-03) and deciding `Difficulty`/`Tags` (LS-05).
