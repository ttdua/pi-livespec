## 1. Engine reports gate-only checks without a valid result

Blocked by: none

- [x] 1.1 Add `hasGateResults(name, key)` to `src/engine/registry.ts`
- [x] 1.2 Add `evaluateChecks` returning `{ checks, unrun }` in `src/engine/checks.ts`; `runChecks` returns its `checks`
- [x] 1.3 Tests in `tests/engine/checks.test.ts`: Gate-only check without a valid result is named, Changed key names the check again, unkeyed check always named, gate request returns empty `unrun`
- [x] 1.4 Add optional `gateChecksUnrun` to `ChangeState` and set it in `changeState` (`src/hooks/card-input.ts`)

## 2. Forecast caveat

Blocked by: 1

- [x] 2.1 `escalationForecast` returns the target's unrun gate-only checks; `gateReady` drops the caveat when that list is empty
- [x] 2.2 Next-step tests in `tests/engine/next-step.test.ts`: No gate-only result keeps the caveat (field absent, or naming `verify-red-on-base`, or naming an unkeyed check), Passing gate-only result drops the caveat, Failing gate-only result names the escalation
- [x] 2.3 E2E in `tests/e2e/gates-flow.test.ts`: a refused `spec_gate plan` with a failing stub names `verify-red-on-base` at the next `spec_status`; with a passing stub and a refusal for another reason the caveat is gone
- [x] 2.4 `CHANGELOG.md` Unreleased entry
