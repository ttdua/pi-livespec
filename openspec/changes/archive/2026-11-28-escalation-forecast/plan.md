# Escalation forecast: gate-only checks without a result — Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** In a session where `spec_gate` already ran the gate-only checks, the plan-gate forecast drops "unless a gate-only check fails" when every gate-only check of the gate has a valid result with no error.

**Architecture:** The registry tells a memo miss from an empty memo. A new `evaluateChecks` returns the results plus the gate-only checks without a valid result; the card and `spec_gate` put that list on the change state; the forecast keeps its caveat only while the target's list is non-empty or unknown.

**Tech Stack:** TypeScript, Bun, Vitest (`bunx vitest run <path>`).

## Global Constraints

- No ledger, forge, refusal, `verify-red-on-base` or `unitCache` change (cross-session state is LS-12, #58).
- Caveat text stays exactly `Checks pass; the <phase> gate can pass unless a gate-only check fails.`; the no-caveat text is exactly `Checks pass; the <phase> gate can pass.`
- Code, comments, commits in English. Follow `~/.agents/skills/coding-standards/SKILL.md`.

## Review Focus

- A `ChangeState` built without `gateChecksUnrun` (fixtures, `stateNow`) must keep the caveat — Task 2 "No gate-only result keeps the caveat" with the field absent.
- An unkeyed gate-only check (`review-clean`) must always count as without a result — Task 1 "unkeyed check always named".
- A gate run overtaken by `clearGateMemo` must not count as a result — Task 1 existing overtaken-run test asserts `unrun` too.
- A gate with an unkeyed gate-only check always keeps the caveat — Task 2 "No gate-only result keeps the caveat" with `gateChecksUnrun: ["review-clean"]`.
- A passing run followed by a unit edit must bring the caveat back — Task 1 "Changed key names the check again".

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `hasGateResults(name: string, key: string \| undefined): boolean` (`src/engine/registry.ts`) | new | true when the memo of `name` was stored under `key` (`key` defined) | no |
| `CheckEvaluation` (`src/engine/checks.ts`) | new | `{ checks: CheckResult[]; unrun: string[] }` | no |
| `evaluateChecks(pack, state, ctx, opts): Promise<CheckEvaluation>` (`src/engine/checks.ts`) | new | same parameters as `runChecks` | no |
| `runChecks` | modified | unchanged signature; returns `(await evaluateChecks(...)).checks` | no |
| `ChangeState.gateChecksUnrun` (`src/engine/state-types.ts`) | new | `gateChecksUnrun?: string[]` | no |
| `GateForecast.unrun`, `escalationForecast` return | modified | adds `unrun?: string[]` | no |

---

## Task 1: Engine reports gate-only checks without a valid result — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/engine/registry.ts`, `src/engine/checks.ts`, `src/engine/state-types.ts`, `src/hooks/card-input.ts`
- Test: `tests/engine/checks.test.ts`

**Interfaces:**
- Produces: `hasGateResults`, `CheckEvaluation`, `evaluateChecks`, `ChangeState.gateChecksUnrun` (see Contracts).

- [ ] **Step 1:** Failing tests in `describe("gate-only checks")` of `tests/engine/checks.test.ts`, with `const evaluate = (opts?) => evaluateChecks(withSlow(), stateFor("plan"), { root: "/nowhere", git: NO_GIT }, opts)`:
  - "Gate-only check without a valid result is named": register `slow` returning `[]`; `evaluate()` → `{ checks: [], unrun: ["slow"] }`; `evaluate({ gate: true, target: "plan" })` → `unrun: []`; `evaluate()` → `{ checks: [], unrun: [] }`.
  - "Changed key names the check again": gate run under `"k"`, then `key = "other"`; `evaluate()` → `unrun: ["slow"]`.
  - "unkeyed check always named": register `slow` with `{ at: "gate" }` and no key; after a gate run, `evaluate()` → `unrun: ["slow"]`.
  - Extend "results of a check that finishes after clearGateMemo are not stored": a later `evaluate()` has `unrun: ["slow"]`.
  - Extend "a gate run stores results that a refresh with the same key returns": `evaluate()` after the gate run has `unrun: []`.
- [ ] **Step 2:** `bunx vitest run tests/engine/checks.test.ts` → the new assertions FAIL.
- [ ] **Step 3:** Add `hasGateResults` next to `storedGateResults`. In `checks.ts`, `resultsOf` returns `{ results, unrun: boolean }` (`unrun` = gate-only, not a gate request, and `!hasGateResults(name, key)`); `evaluateChecks` collects both; `runChecks` delegates.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Add `gateChecksUnrun?: string[]` to `ChangeState` with doc comment "gate-only checks reported with no valid last result; undefined when unknown". `changeState` (`card-input.ts`) calls `evaluateChecks` and sets `checks` and `gateChecksUnrun`. `withGateChecks` and `stateNow` stay on `runChecks` (neither forecasts).
- [ ] **Step 6:** `bunx tsc --noEmit` and `bunx vitest run tests/engine tests/hooks tests/tools` → no new failures.
- [ ] **Step 7:** Commit `feat(engine): report gate-only checks without a valid result`.

---

## Task 2: Forecast caveat — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4
**Difficulty:** Normal
**Blocked by:** Task 1

**Files:**
- Modify: `src/engine/gate-escalation-facts.ts`, `src/engine/gate-decision.ts`, `CHANGELOG.md`
- Test: `tests/engine/next-step.test.ts`, `tests/e2e/gates-flow.test.ts`

**Interfaces:**
- Consumes: `ChangeState.gateChecksUnrun` (Task 1).
- Produces: `GateForecast.unrun?: string[]`.

- [ ] **Step 1:** Failing tests in `tests/engine/next-step.test.ts` next to "no trigger keeps the self forecast":
  - "No gate-only result keeps the caveat": `reviewedState("plan", untagged)` without the field, with `gateChecksUnrun: ["verify-red-on-base"]`, and with `gateChecksUnrun: ["review-clean"]` (an unkeyed check name) → `"Checks pass; the plan gate can pass unless a gate-only check fails."`.
  - "Passing gate-only result drops the caveat": `gateChecksUnrun: []` → `"Checks pass; the plan gate can pass."`.
  - "Failing gate-only result names the escalation": `gateChecksUnrun: []`, `checks: [{ check: "verify-red-on-base", code: "verify-red-on-base", severity: "error", message: "U2 green" }]` → `"The plan gate will ask the human: verify-red-on-base fails. Pass a briefing to spec_gate plan. The human can waive verify-red-on-base, or fix them first."` (may already pass; keep as regression).
- [ ] **Step 2:** `bunx vitest run tests/engine/next-step.test.ts` → the first three FAIL where expected.
- [ ] **Step 3:** `escalationForecast` adds `unrun: state.gateChecksUnrun` (no filter, design D4). `gateReady` on `self`: caveat unless `forecast.unrun` is an empty array; update its comment.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** E2E in `tests/e2e/gates-flow.test.ts`, setup as "plan gate passes alone once the advisory review is clean":
  - "a failing gate-only run names the escalation": stub `verify-red-on-base` returns an error (`key: () => "stub"`); `spec_gate plan` without briefing refuses naming `briefing`; `spec_status` → `step.next` is `"The plan gate will ask the human: verify-red-on-base fails. Pass a briefing to spec_gate plan. The human can waive verify-red-on-base, or fix them first."`.
  - "a passing gate-only run drops the caveat": stub returns `[]`; before the gate `step.next` has the caveat; make the tree dirty (`writeIn` an untracked file), `spec_gate plan` refuses naming the dirty tree; remove the file; `spec_status` → `"Checks pass; the plan gate can pass."`.
  - The existing assertion in "plan gate passes alone…" (caveat before any gate run) stays.
- [ ] **Step 6:** `CHANGELOG.md` `[Unreleased]` → `### Changed`: "After `spec_gate` ran the gate-only checks in this session and they passed, the next step no longer says the plan gate can pass only \"unless a gate-only check fails\" (#75)."
- [ ] **Step 7:** `bunx vitest run` and `bunx tsc --noEmit` → only known #76 flakes may fail; record them.
- [ ] **Step 8:** Commit `feat(next-step): drop the gate-only caveat after a known passing run`.

---

## Scenario → test

- flow-engine "Units check in plan", "Only active phase checks", "Capabilities mismatch" → existing `tests/engine/checks.test.ts`
- flow-engine "Gate-only check skipped on refresh" → existing `tests/engine/checks.test.ts`
- flow-engine "Gate-only check without a valid result is named" → `tests/engine/checks.test.ts` (Task 1)
- flow-engine "Changed key names the check again" → `tests/engine/checks.test.ts` (Task 1)
- phase-gates "Next step names the escalation", "Failing waivable check names the escalation" → existing `tests/engine/next-step.test.ts`
- phase-gates "Failing gate-only result names the escalation" → `tests/engine/next-step.test.ts` and `tests/e2e/gates-flow.test.ts` (Task 2)
- phase-gates "No gate-only result keeps the caveat" (incl. the unkeyed-check clause) → `tests/engine/next-step.test.ts` and existing e2e assertion (Task 2)
- phase-gates "Passing gate-only result drops the caveat" → `tests/engine/next-step.test.ts` and `tests/e2e/gates-flow.test.ts` (Task 2)
