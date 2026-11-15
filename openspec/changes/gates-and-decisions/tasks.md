## 1. Decision seam, rules and pack decisions

Blocked by: none

- [x] 1.1 Add `src/decide/registry.ts`: `registerRule(point, schema, fn)`, the `decisions` pack sub-schema (unknown point, `mode: rule` only, `jev` rejected with line and column), the per-point merge used by `mergePack`, and `registerBuiltinRules()` so tests can re-register after a reset
- [x] 1.2 Add `src/decide/rules/tags.ts` (path globs via `matchGlob`, keywords matched as whole words or phrases ignoring case, `extra_tags` append-only and reported as `agentAdditions` data, per-tag union merge) and `src/decide/rules/difficulty.ts`
- [x] 1.3 Add `src/decide/seam.ts` `decide(point, facts, deps)`, which returns rule outcomes with typed `data`, or sends `ask` through an injected approver
- [x] 1.4 Add `src/decide/records.ts`: the `decision` comment body (`facts_hash` above 2,000 characters, `agent_additions`, `overridden_by`), the latest-record-per-id reader, and the small-fix PR-body `formatDecisionBlock` and `parseDecisionBlocks`
- [x] 1.5 Import the rule bootstrap from `src/engine/pack-load.ts` (like `./checks.ts`). Fill `decisions.tags` and `decisions.difficulty` in `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json`, and make `pack-merge.ts` merge `decisions` per point

## 2. Approver contract, command parser, config and in-session adapter

Blocked by: none

- [x] 2.1 Add `src/interaction/approver.ts`: the contract types (`Approver` with `request` and `poll`, the `answered`, `pending` and `deferred` results, question answer text, overrides), and register marker kinds `request` and `answer`
- [x] 2.2 Add `src/interaction/commands.ts`: pure `parseCommand` over the comment's first line, for `approve`, `changes`, `dismiss`, `choose`, `answer` (with `--changes` and `--class`), `class` and `set`
- [x] 2.3 Add `interaction.adapter` to project and user config in `src/config.ts` (warnings for non-lists and unknown names, default `[in-session]`), plus `adapterChain(config)`
- [x] 2.4 Add `src/interaction/in-session.ts`: dialogs through an injected `ApproverUI`, availability from `hasUI`, cancel read as `dismissed`, question flow with "answer later" returning `deferred`, override prompts
- [x] 2.5 Add `src/interaction/chain.ts` `runChain(chain, adapters, request)`: tries adapters in order, skips unavailable ones, moves on after `deferred` once the caller's `onDeferred` hook has rewritten the question as non-blocking, and refuses with a message naming `interaction.adapter`

## 3. Byte-preserving body helpers

Blocked by: none

- [x] 3.1 Add `src/core/unit-blocks.ts`: `renderUnit`, `replaceUnitBlock`, `insertUnitBlock`, `removeUnitBlock` and `setUnitField`, all keeping every other line and its EOL
- [x] 3.2 Add `src/core/question-lines.ts`: `appendQuestion`, `answerQuestion` and `reclassifyQuestion`, all keeping every other line and its EOL

## 4. Change-state facts, classification check and gate evaluation

Blocked by: 1, 2

- [x] 4.1 Add `src/interaction/requests.ts`: `prepareRequest` (the durable request envelope with a per-subject snapshot), write `request` and `answer` comments, and derive the pending, applying and completed requests from own marked comments (pure)
- [x] 4.2 Add `src/engine/locks.ts` (pure): the lock from the plan gate plus amendments, frozen units, stale units and phases, the valid gate result per phase, and `gateDigest`
- [x] 4.3 Add `src/engine/iterations.ts` (pure): `change_iterations` from `after_plan` stale comments, and the cap-blocking predicate with stuck answers
- [x] 4.4 Extend `ChangeState` and `readChangeSnapshot` with `marked`, requests, lock, iterations and command warnings, and make `readCounters` ignore a `change_iterations` counter comment
- [x] 4.5 Add `registerCheck(name, fn, { waivable })`, `CheckContext.marked`, and the `unit-classification` check, and add `unit-classification` to `plan.checks` in the pack and the fixture
- [x] 4.6 Add `Git.diffStat` and `diffNames`; add `src/engine/gates.ts` (`registerGate`, the pure `gateRefusal`, `registerGatePayload`) and `src/engine/gate-payload.ts` (`collectReviewFacts`, I/O, and the pure `gatePayload` for define, plan and ship)

## 5. Next step and phase card

Blocked by: 4

- [x] 5.1 Extend `nextStep` precedence: stuck report, pending or applying blocking request, cap blocking, blocking question, frozen or stale units in lock scope, then the existing rules
- [x] 5.2 Derive the gate sentence and `advance` from the valid gate result (`changes_requested`, `dismissed`, superseded, ship approved, no advance at ship)
- [x] 5.3 Add the `approvals` card section: pending requests with their adapter, frozen and stale units, the open stuck report, and ignored-command warnings wrapped as untrusted

## 6. Completion engine, forge adapter, polling and doctor

Blocked by: 3, 4, 5

- [x] 6.1 Add `src/interaction/complete.ts`: validate an answer once (HEAD, gate digest, `gateRefusal` ignoring the request itself, the amendment snapshot and the resulting plan), record the `answer` comment, then dispatch to one apply module per subject kind and write the result comment last
- [x] 6.2 Add the apply modules `complete-gate.ts` (overrides, `stale` on changes), `complete-amend.ts`, `complete-question.ts` (answer line, reclassify, cascade in design D12 order), `complete-stuck.ts` and `complete-decide.ts`, each idempotent
- [x] 6.3 Add `src/interaction/forge.ts`: request comment with yaml and plain-text instructions, one pending request per subject, `poll(requestId)`, and the pure `matchCommands` with permission, timing and ambiguity rules that produce ignored-command warnings
- [x] 6.4 Add `src/interaction/poll.ts` `pollApprovals` (finish applying requests first, then read fresh comments for pending ones) and `src/tools/register.ts`, which wraps every livespec tool (including `spec_validate`) so polling runs before it; hook polling into `session_start` and `/livespec next`
- [x] 6.5 Add `src/tools/approver-for.ts` (the adapter chain from session config and the tool `ctx`), and the approver doctor check with config and `hasUI` added to `DoctorDeps`

## 7. Gates tool

Blocked by: 5, 6

- [x] 7.1 Extend `tests/hooks/fake-pi.ts` `fakeCtx` with scripted `confirm` and `input`, and `tests/tools/helpers.ts` with a UI option
- [x] 7.2 Add `spec_gate` in `src/tools/spec-gate.ts`: self gates, human gates through the chain with the review payload, `waive` options, and gate comments with `locked` and `agent_skills`; no answer parameters
- [x] 7.3 Register `spec_gate` through the polling wrapper

## 8. Unit planning and amendments

Blocked by: 7

- [ ] 8.1 Add `Git.merge`, `mergeAbort` and `isAncestor` in `src/engine/git.ts`
- [ ] 8.2 Add `src/tools/classify-units.ts`, which runs both rules per unit and builds the records
- [ ] 8.3 Add `plan_units` (`src/tools/plan-units.ts` plus `plan-units-steps.ts`): refusals, base repair, classify, validate, merge or abort, records, version-checked write, config update after the write, and an unknown-outcome re-read of `Base` and Units
- [ ] 8.4 Add `unit_amend` (edit, `--add`, `--drop`): whole-plan validation, refusing to drop a depended-on unit, and a light gate request with only the affected units

## 9. Questions and stuck tools

Blocked by: 8

- [ ] 9.1 Add `spec_question` (append `Q<n>`, class, `reask`) over the chain
- [ ] 9.2 Add `spec_stuck` (2–3 options, a recommended option, links), which writes the `stuck` report comment and sends a blocking request

## 10. Docs and end-to-end verification

Blocked by: 9

- [ ] 10.1 Add the cross-tool test `Tool has no answer parameter` over the parameter schemas of all five new tools
- [ ] 10.2 Add an integration test over a fake forge and fake UI: define gate → plan_units → plan gate through forge → web edit freeze → amend → question cascade → stuck report at the cap (cap 1 via a project override) → choice lifts the block
- [ ] 10.3 Update `docs/architecture.md` (interaction, decide, the request lifecycle, the known LS-06 gaps)
- [ ] 10.4 Run `bun run typecheck` and `bun run test`, plus a manual TUI smoke of `spec_gate` in session and a forge `/livespec approve`, and record the results in `smoke.md`
