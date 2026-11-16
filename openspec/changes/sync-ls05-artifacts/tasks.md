## 1. Stale units cleared by a plan approval

Blocked by: none

- [x] 1.1 `staleUnitsOf` in `src/engine/locks.ts` clears a unit when an approved amendment for it or an approved, non-superseded plan gate is newer than the `stale` comment (design D1)
- [x] 1.2 Remove `LockState.stalePhases` and `stalePhasesOf`; update every test consumer (`tests/helpers/change-state.ts`, `tests/hooks/phase-card.test.ts`, `tests/engine/next-step.test.ts`, `tests/engine/locks.test.ts`) (design D4)
- [x] 1.3 Tests in `tests/engine/locks.test.ts`: "Stale before the first lock" (unit level, `deriveLocks`) and "Identical amendment clears a stale unit"; e2e "Stale before the first lock" through the cascade, define and plan gates in `tests/e2e/gates-flow.test.ts`

## 2. Adapter chain fallback

Blocked by: none

- [x] 2.1 `adapterChain` in `src/config.ts` uses a layer only when its list is non-empty: project, then user, then default (design D3)
- [x] 2.2 Replace the two tests in `tests/config.test.ts` that pin the old masking with "Project list with only unknown names" and "Empty project list" (chain `[forge]`, source `user`), and add "Every list empty" (chain `[in-session]`, source `default`)

## 3. Approver contract cleanup

Blocked by: 1

- [x] 3.1 Remove `Approver.poll` from `src/interaction/approver.ts`, the forge implementation in `src/interaction/forge.ts` and the in-session stub in `src/interaction/in-session.ts`; port the `approver.poll` tests in `tests/interaction/forge.test.ts` to `matchCommands` or `pollApprovals` so their command-matching assertions stay, and drop the in-session stub test (design D4)
- [x] 3.2 Remove `ApproverUI.confirm` from the type, `src/tools/approver-for.ts` and `src/hooks/session.ts` adapters and test doubles
- [x] 3.3 Remove `GateSnapshot.digests` from the type and `src/tools/spec-gate.ts`; a request comment still carrying `digests` parses
- [x] 3.4 `Subject` becomes the template-literal union; `asRequestRecord` in `src/interaction/requests.ts` rejects a subject with an unknown prefix (design D5)
- [x] 3.5 Add `snapshotOf(record)` in `src/interaction/requests.ts` returning a union discriminated by subject prefix; replace the `as XSnapshot` casts in `complete-gate.ts`, `complete-validate.ts`, `complete-amend.ts`, `complete-question.ts`, `complete-stuck.ts`, `complete-decide.ts`
- [x] 3.6 `summary` in `src/interaction/complete.ts` stops wrapping `record.reason`; `validateAmend` wraps unit validator text where it builds the reason (design D6); test that a superseded result holds exactly one `<untrusted>` around forge text
- [x] 3.7 Tests: "Amendment request kind" in `tests/tools/unit-amend.test.ts`, "Decide request kind" in `tests/tools/decide-ask.test.ts`; `bun run typecheck` and `bun run test` pass

## 4. `/livespec class` applied once

Blocked by: 3

- [ ] 4.1 Register marker kind `class` (`src/interaction/approver.ts`); after `applyClasses` rewrites the body, or finds the class already set, post an own `class` comment with id = command comment id and data `{ question, class }`; no marker on a write conflict (design D2)
- [ ] 4.2 `matchCommands` takes the applied command ids (`MatchOptions`) and skips those `class` commands; `poll.ts` passes them from own `class` markers
- [ ] 4.3 Tests in `tests/interaction/poll.test.ts`: "Class command applied once", "Class command recorded across sessions", "Class command already matching", "Class rewrite conflict retried", and the marker-write-failure known gap; "Human reclassifies" still passes

## 5. Spec-gap scenarios on existing behaviour

Blocked by: 3

- [ ] 5.1 Tests with the exact scenario names: "Answer later in session" (`tests/tools/spec-question.test.ts`), "Named gate option recorded" and "Dirty tree when the answer is read" (`tests/tools/spec-gate.test.ts`), "Waived check does not hold the next step" (`tests/engine/next-step.test.ts`), "Dismissed stuck answer keeps the cap" (`tests/tools/spec-gate.test.ts` or `tests/engine/iterations.test.ts`)
- [ ] 5.2 Extend "Waive at the gate" to assert the move to `build`; add "Waived ship gate stays in ship"; rename the in-session named-option test to "Named gate option does not waive"; extend "Choice recorded" to assert the stuck answer comment's `outcome`; give "Stuck answer lifts the cap" outcome `approved` and choice `B`
- [ ] 5.3 Fix any code the new tests show diverging from the deltas (expected none)

## 6. Archived artifacts and docs

Blocked by: 1, 2, 3, 4

- [ ] 6.1 Archived `2026-11-16-gates-and-decisions/design.md`: D3 (polling through the `registerLivespecTool` wrapper), D5 (`select` for yes/no, no `confirm`), D9 step 4 (`git merge --no-ff --no-edit`), D13 (`lock.gates`, `iterations.stuckOpen`); append `## Errata (#20)`
- [ ] 6.2 Archived `plan.md` Contracts: `Approver` (no `poll`), `ApproverUI` (no `confirm`), `RequestRecord`/`GateSnapshot` (no `digests`), `LockState` (no `stalePhases`), `Subject`, marker `stuck` answer data (`outcome`), `interaction.adapter` fallback, kind per subject; drop the "Spec contract note"; append `## Errata (#20)`
- [ ] 6.3 Archived `proposal.md`: add "Loop counters" to the `flow-engine` modified requirements and cross-session or cross-machine double completion to the known gaps; append `## Errata (#20)`
- [ ] 6.4 `docs/architecture.md`: approver contract without `poll`, the `class` marker, adapter fallback
