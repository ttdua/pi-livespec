# Verification Report

**Change**: `escalation-forecast`
**Verified at**: `2026-11-28 13:31 UTC`
**Iteration**: `1`
**Verifier**: parent session (fresh full suite, tsc, validate, git) with independent evidence from `superspec.verifier` (validate, tasks, requirement and scenario mapping, contracts, focused tests)

---

## 1. Structural Validation (`openspec validate <change>`)

- [x] The command passes for this change

**Result**:

```text
openspec validate escalation-forecast          -> Change 'escalation-forecast' is valid (exit 0)
openspec validate escalation-forecast --strict -> Change 'escalation-forecast' is valid (exit 0, verifier)
```

---

## 2. Task Completion (`tasks.md`)

- [x] Every box is ticked, or each open box has a recorded reason

8 of 8 ticked (`openspec instructions apply` progress `{"total":8,"complete":8,"remaining":0}`).

| Open task | Reason | Blocks archive? |
|---|---|---|
| — | — | — |

---

## 3. Requirement Evidence

- [x] ADDED / MODIFIED: implementation evidence (file / line)
- [x] REMOVED: not applicable (none)
- [x] RENAMED: not applicable (none)

| Requirement | Operation | Status | Evidence (file:line) or reason |
|---|---|---|---|
| flow-engine: Named checks over LS-02 validators | MODIFIED | Pass | `src/engine/registry.ts:95-97` `hasGateResults` (unkeyed → false); `src/engine/checks.ts:117-126` `resultsOf` returns `unrun`; `:132` `CheckEvaluation`; `:140-146` `runChecks` delegates; `:150-165` `evaluateChecks` collects `unrun`; `src/hooks/card-input.ts:151,157`; `src/engine/state-types.ts:42` |
| phase-gates: Escalation in the next step | MODIFIED | Pass | `src/engine/gate-escalation-facts.ts:64,70` forecast passes `unrun: state.gateChecksUnrun`; `src/engine/gate-decision.ts:14` `GateForecast.unrun`; `:22-24` caveat unless `unrun` is `[]`, strings exact |

---

## 4. Scenario Coverage

- [x] Every scenario maps to a test
- [x] The project test command was run fresh in this step

**Test command**: `bunx vitest run --testTimeout=120000` (plus `bunx tsc --noEmit`)
**Result**: `267 files, 4316 passed, 0 failed` (exit 0, 535 s). `tsc`: no errors (exit 0).

Run history in this step, all recorded:
- `bunx vitest run` (default 30 s timeout), with the verifier running in parallel: 5 failed / 4311 passed; all 5 were `Test timed out in 30000ms`.
- Same, alone: 11 failed / 4305 passed, all `Test timed out in 30000ms`, host load average 177 (about 20 vitest processes from other sessions).
- Failed files alone: 6 failed / 113 passed, all timeouts, load about 120.
- Those e2e files alone, `--testTimeout=120000 --maxWorkers=1`: 41/41 passed.
- Full suite `--testTimeout=120000`: 4316/4316 passed (the result above).
No failure was an assertion error; every one was the 30 s timeout under host load (issue #76 class).

| Scenario | Test |
|---|---|
| flow-engine: Units check in plan | `tests/engine/checks.test.ts:77` |
| flow-engine: Only active phase checks | `tests/engine/checks.test.ts:84` |
| flow-engine: Gate-only check skipped on refresh | `tests/engine/checks.test.ts:293` |
| flow-engine: Capabilities mismatch | `tests/engine/checks.test.ts:105` |
| flow-engine: Gate-only check without a valid result is named | `tests/engine/checks.test.ts:274` |
| flow-engine: Changed key names the check again | `tests/engine/checks.test.ts:281` |
| phase-gates: Next step names the escalation | `tests/engine/next-step.test.ts:1168` |
| phase-gates: Failing waivable check names the escalation | `tests/engine/next-step.test.ts:1184` |
| phase-gates: Failing gate-only result names the escalation | `tests/engine/next-step.test.ts:1237`; `tests/e2e/gates-flow.test.ts:223` |
| phase-gates: No gate-only result keeps the caveat | `tests/engine/next-step.test.ts:1225` (field absent, unrun names, unkeyed name); `tests/e2e/gates-flow.test.ts` existing assertion in "plan gate passes alone once the advisory review is clean" |
| phase-gates: Passing gate-only result drops the caveat | `tests/engine/next-step.test.ts:1232`; `tests/e2e/gates-flow.test.ts:233` |

---

## 5. Design and Contract Coherence (warning only)

- [x] Decisions in design.md match the code
- [x] Contracts in plan.md, with the Contract deviations recorded in apply.md, match the code

- D1 `hasGateResults`: matched (`registry.ts:95`).
- D2 `evaluateChecks` / `runChecks` delegation, gate request `unrun: []`: matched (`checks.ts:140-165`).
- D3 optional `gateChecksUnrun`, set only in `changeState`; `withGateChecks` (`src/tools/spec-gate.ts:185`) and `stateNow` (`src/interaction/complete-validate.ts:45`) stay on `runChecks`: matched.
- D4 forecast passes `unrun` unfiltered; caveat unless empty array: matched.
- plan.md Contracts (6 rows): all matched. apply.md Contract deviations: none, consistent.

**Drift warnings** (non-blocking): None.

---

## 6. Clean Tree and Commit Range

- [x] Working tree is clean (`git status --porcelain` empty before this receipt)

**Commit range**: `57ab980..7ea0d9d` (this receipt commit follows). `git diff --stat 57ab980..7ea0d9d -- src/ledger src/forge src/evidence src/tools/spec-gate.ts src/interaction` is empty.

---

## Overall Decision

- [ ] PASS: proceed with `/opsx-continue` to finalize
- [x] PASS_WITH_WARNINGS: proceed, noting: the full suite passed only with `--testTimeout=120000`; under host load (load average 110–177) the default 30 s timeout fails 5–11 unrelated e2e/tool tests with timeouts only (#76). Confirm a green default-timeout run in CI or on an idle machine.
- [ ] FAIL: fix the cause, then re-apply (iteration N+1)

### Issues

**CRITICAL**: none.

**WARNING**
- Default-timeout full suite not green on this host under load (timeouts only, #76). Recommendation: rely on CI for the default-timeout run before merge.

**SUGGESTION**
- `src/engine/checks.ts:158-163`: dedupe `unrun` (`!unrun.includes(name)`) if a pack can list a check twice.
- `src/engine/checks.ts:116`: mention the `unrun` flag in the `resultsOf` doc comment.
- `src/engine/gate-escalation-facts.ts:64`: reuse `GateForecast` as the return type.

**Next step**:

Run `/opsx-continue` with this worktree as the working directory to create the finalize artifact, then `/opsx-archive`.
