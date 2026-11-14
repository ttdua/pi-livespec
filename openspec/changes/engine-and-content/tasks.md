## 1. Flow pack loader and registry

Blocked by: none

- [x] 1.1 Add the registry module `src/engine/registry.ts` (`registerPackSchema`, `personasForPack`, `registerCheck`, `getCheck`, `checkNames`) with a test reset helper
- [x] 1.2 Add the hand-written pack schema walker `src/engine/pack-schema.ts` with file, line and column errors (types, enums, unknown keys, model and lane keys)
- [x] 1.3 Add the default pack `src/packs/agent-skills.yaml` and the canonical fixture `tests/fixtures/agent-skills.pack.json`, both transcribed from issue #4
- [x] 1.4 Add `src/engine/pack-load.ts`: load default plus `.pi/livespec/flow.yaml`, merge by phase id with origins, semantic checks (unique ids, requires, cycles, check names, outputs, excluded-skill warnings)

## 2. Byte-preserving section helpers

Blocked by: none

- [ ] 2.1 Add `src/core/sections.ts` (`sectionText`, `replaceSection` with canonical order, `setHeaderLine`) with byte-preservation tests over `tests/fixtures/change-body.md`, `src/core/templates.ts` with `TEMPLATE_MARKER`, and `src/core/names.ts` with `isKebabName`

## 3. Config files and git runner

Blocked by: none

- [ ] 3.1 Add `src/config.ts` reading project `.pi/livespec/config.yaml` (forge keys, `integrationBranch`) and user `~/.pi/agent/livespec/config.yaml` (`agentSkills.channel`), with defaults and unknown-key warnings
- [ ] 3.2 Add `src/engine/git-exec.ts`: a git runner with per-call `cwd` and `env`, shared by the engine and the content manager

## 4. Engine state, checks and next step

Blocked by: 1, 2, 3

- [ ] 4.1 Add `src/engine/git.ts` over the Task 3 runner (branch, HEAD, dirty, `specs/` diff from Base, config keys, not-found exit mapping, integration branch resolution)
- [ ] 4.2 Add `src/engine/comments-cache.ts` (raw comments keyed by issue `updatedAt`, 5-minute bound, invalidation on own write, login filtering on read), and register marker kind `skill-note`
- [ ] 4.3 Add `src/engine/checks.ts` registering `spec-format`, `units-format`, `done-maps-scenarios`, `capabilities-match-diff`, plus `runChecks`
- [ ] 4.4 Add `src/engine/snapshot.ts` (`readChangeSnapshot` → `ChangeState`, stale and `phase-ambiguous`)
- [ ] 4.5 Add the pure `src/engine/next-step.ts` with the precedence rules, successor rule and table tests
- [ ] 4.6 Add `src/engine/counters.ts` (read with caps, set in place) and `src/engine/advance.ts` (`advancePhase`, add-then-remove, idempotent retries)
- [ ] 4.7 Add `src/engine/resolve-change.ts` (branch → issue, fallback by title, open change list)

## 5. agent-skills content

Blocked by: 1, 3

- [ ] 5.1 Add `src/content/paths.ts`, `src/content/lock.ts` (lock read/write) and `src/content/wip.ts` (`registerWorkInProgress` and the default build-phase predicate)
- [ ] 5.2 Add `src/content/mirror.ts` (bare mirror fetch, checkout into staging with a temporary index) tested against a local bare upstream
- [ ] 5.3 Add `src/content/compat.ts` (skill front matter and persona checks)
- [ ] 5.4 Add `src/content/upgrade.ts`: pure `decideUpgrade` plus install, atomic `current` switch, skill-change diff, pin, unpin, rollback, kept-tree pruning, work-in-progress guard for automatic, update and pin
- [ ] 5.5 Add `src/content/expose.ts` (pack → real skill paths, exclusions, initialized-only)

## 6. Init, doctor and skills commands

Blocked by: 4, 5

- [ ] 6.1 Add `/livespec init` in `src/commands/init.ts` with templates, the constraints template marker and idempotent reporting
- [ ] 6.2 Add `/livespec doctor` in `src/commands/doctor.ts` with injected deps, `registerDoctorCheck` and each check from the spec
- [ ] 6.3 Add `/livespec skills status | update | pin | unpin | rollback` in `src/commands/skills.ts`

## 7. Context injection and resume

Blocked by: 4, 5

- [ ] 7.1 Add the static routing note `src/hooks/routing-note.ts` with the Core Operating Behaviors summary and MIT attribution
- [ ] 7.2 Add the pure `renderCard` and `registerCardSection` in `src/hooks/phase-card.ts` (untrusted wrapping, stale notice, product pointer, constraints prompt, skill-note reminder, registered sections)
- [ ] 7.3 Add `src/hooks/session.ts`: the `Session` holder, forge setup through `detectForge` + `CachedForge`, resume card, build → review auto-advance, background upgrade kick-off, uninitialized-project message
- [ ] 7.4 Add `src/hooks/context.ts`: `before_agent_start` section plus snapshot refresh, `context` card append, `tool_call` observer for optional skill reads, `resources_discover`, and refresh after write tools
- [ ] 7.5 Add the five-turn cache-prefix test

## 8. Tools

Blocked by: 4, 7

- [ ] 8.1 Add `spec_status`, `spec_next` and `/livespec next` sharing one formatter
- [ ] 8.2 Add `skill_note`
- [ ] 8.3 Add `spec_write` with validation, version check and read-only refusal
- [ ] 8.4 Add `change_new` (exact initial body) and `change_start` (fetch, branch, `livespecBase` config, Base, rollback only on conflict, re-read on unknown outcome, reconciliation, no push)

## 9. Extension wiring, docs and smoke

Blocked by: 6, 7, 8

- [ ] 9.1 Wire every hook, command and tool in `src/extension.ts` and update the usage text and `tests/extension.test.ts`
- [ ] 9.2 Add an end-to-end resume test: a fake pi session on `livespec/<name>` with the in-memory forge shows the right next step
- [ ] 9.3 Update `docs/architecture.md` (engine and content, pack location)
- [ ] 9.4 Run the manual 5-turn cache smoke through 9router and record it in `openspec/changes/engine-and-content/smoke.md`
- [ ] 9.5 Run `bun run typecheck` and `bun run test`
