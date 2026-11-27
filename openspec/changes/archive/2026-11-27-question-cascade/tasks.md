## 1. Shared requirement-diff detector

Blocked by: none

- [x] 1.1 Add `src/engine/requirement-diff.ts` with `requirementContent` (whitespace-collapsed), `requirementDigests`, `changedIds`, `REMOVED_DIGEST`, `coversId`, `capabilityOf`, `requirementScope` and `COVERS_SEPARATOR` (design D1), moved out of `src/initiatives/sync.ts`; tests in `tests/engine/requirement-diff.test.ts` against a temp git repo
- [x] 1.2 Make `src/initiatives/sync.ts` `staleUnits` use `changedIds` over `requirementDigests` at the old and new base, keeping its `oldBase === base` short-circuit; keep `tests/tools/change-sync.test.ts` green unchanged
- [x] 1.3 Add `Git.hasCommit(sha)` (`git cat-file -e <sha>^{commit}`, exit 128 = absent; used by the legacy path and the `Base` fallback) to `src/engine/git.ts` and every `Git` fake; tests in `tests/engine/git.test.ts`
- [x] 1.4 Move `declaredCapabilities` to `src/core/change.ts` and reuse it from `src/engine/checks.ts` and `src/subagents/source-kit.ts` (keeping its re-export for `sources-git.ts`, `sources-forge.ts` and `docs/readers.ts`)

## 2. Question path without a requirement step

Blocked by: 1

- [x] 2.1 Remove `Answered.changesRequirement`, `QuestionSnapshot.requirements` and `ApprovalRequest.question.requirements` (`src/interaction/approver.ts`); drop `readRequirements`/`requirementNames` from `src/tools/spec-question.ts`; stored snapshots with `requirements` still parse; update `tests/tools/spec-question.test.ts`, `tests/tools/request-summary.test.ts`, `tests/interaction/chain.test.ts` and `tests/interaction/dialog/host.test.ts`
- [x] 2.2 In-session `select` flow: remove `askChangedRequirement` from `src/interaction/in-session.ts`; update `tests/interaction/in-session.test.ts`
- [x] 2.3 Dialog: remove the `requirement` editor, `pickRequirement`, requirement rows and the `canSubmit` requirement rule (`src/interaction/dialog/{state,keys,view,model,result,host}.ts`); update `tests/interaction/dialog/*.test.ts`
- [x] 2.4 Forge: `parseAnswer` refuses `--changes` with the removal message; drop the flag from `src/interaction/forge-match.ts` and `src/interaction/forge-text.ts`; update `tests/interaction/{commands,forge,forge-text,poll}.test.ts`
- [x] 2.5 `applyQuestion` writes only the answer line and the `question` comment; delete `cascade`, `coveringUnits`, `needsMoveBack` and `countsAsIteration` from `src/interaction/complete-question.ts`; drop the "Changes requirement" field in `src/interaction/complete.ts`; update `tests/interaction/complete.test.ts`, and rewrite the cascade parts of `tests/e2e/gates-flow.test.ts` (cap chain and "Stale before the first lock" seed `stale` comments directly)

## 3. Spec-diff cascade and plan-gate digests

Blocked by: 1, 2

- [x] 3.1 Record `requirements` and `requirement_scope` in the plan gate request snapshot at the request's HEAD (`gateRequest` in `src/tools/spec-gate.ts`), copy them into the approved plan `gate` comment (`src/interaction/complete-gate.ts`), compute them at HEAD for the self gate; expose the baseline gate as `LockState.baseline` (`src/engine/locks.ts`)
- [x] 3.2 Add the pure planner `src/interaction/spec-cascade-plan.ts` (`planSpecCascade` dispatching to `planLegacyMissing`, `planCompletion`, `planNewCascade`; `needsMoveBack`; `acknowledgedDigests`; `excludedIds`; `isSpecCascade`; `isBaselineStale`; ids and reasons) with tests in `tests/interaction/spec-cascade-plan.test.ts`
- [x] 3.3 Add `src/interaction/spec-cascade.ts` (`readCascadeInput` with the HEAD, integration-reference and legacy digest maps, `integrationRef` with best-effort fetch, `applyCascade`, single-flight `runSpecCascade` that completes then re-plans once) with tests in `tests/interaction/spec-cascade.test.ts`
- [x] 3.4 Confirm `change_iterations` and `lock.staleUnits` read the new `stale` comments unchanged (`tests/engine/iterations.test.ts`, `tests/engine/locks.test.ts`)

## 4. Phase rule for unit_finish

Blocked by: none

- [x] 4.1 Check the phase first in `unit_finish`'s `precheck` (`src/tools/unit-finish.ts`) and add `notPerUnit` to `RUN_RULES` and `RECONCILE_RULES` in `src/evidence/refusals.ts`; re-read the phase before the tick; tests in `tests/evidence/refusals.test.ts` and `tests/tools/unit-finish.test.ts` for a started and a receipted unit outside `build`

## 5. Triggers and end-to-end

Blocked by: 3, 4

- [x] 5.1 Call `runSpecCascade` after `pollApprovals` in `startSession` (`src/hooks/session.ts`) and `runNextCommand` (`src/commands/next.ts`); in `runSpecGate` right after `prepareWrite` and before `requireChange`; in `unit_finish` through a `before` hook in a new options object of `lockedEvidenceCall` (`src/tools/unit-tool.ts`, `src/tools/unit-finish.ts`, callers in `unit-start.ts` and `lane-merge.ts`); `Git` fakes default `hasCommit` to true
- [x] 5.2 E2E tests in `tests/e2e/spec-cascade.test.ts`, one per cascade scenario of the delta specs
- [x] 5.3 Run `bun run typecheck` and `bun run test`

## 6. Docs

Blocked by: 2, 3, 4, 5

- [x] 6.1 Update `README.md`, `README.vi.md` and `docs/architecture.md` (forge command grammar without `--changes`, the answer section, the cascade paragraph, the plan-gate `requirements` field)
- [x] 6.2 Add the breaking `--changes` removal, the spec-diff cascade and the `unit_finish` phase rule to `CHANGELOG.md` under Unreleased
