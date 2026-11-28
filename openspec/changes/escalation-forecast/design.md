## Context

- `resultsOf` (`src/engine/checks.ts`) returns `storedGateResults(name, key)` on a refresh. `storedGateResults` (`src/engine/registry.ts`) returns `[]` both when no memo matches and when the memo holds a run with no result, so callers cannot tell them apart.
- `storeGateResults` stores a gate run's results under its key whatever they are (an empty list included), only when the check has a key and no `clearGateMemo` ran meanwhile.
- `escalationForecast` (`src/engine/gate-escalation-facts.ts`) and `gateReady` (`src/engine/gate-decision.ts`) produce the caveat for every covered `self` forecast.
- `runChecks` has three callers in `src`: `changeState` (`src/hooks/card-input.ts`), `withGateChecks` (`src/tools/spec-gate.ts`) and `stateNow` (`src/interaction/complete-validate.ts`).

## Goals / Non-Goals

**Goals:**
- After a gate run in the same session, the forecast drops the caveat when every gate-only check of the gate has a valid result with no error.

**Non-Goals:**
- Results across sessions, clones or lanes; any ledger or forge write (left to LS-12, #58).
- Changing `verify-red-on-base`, its key, or `unitCache`.
- Changing what `spec_gate` runs or refuses.

## Decisions

### D1. `hasGateResults(name, key): boolean` in the registry
True when the memo of `name` was stored under `key` (`key` defined). `storedGateResults` keeps its contract. Alternative: make `storedGateResults` return `undefined` for a miss; it changes a shared signature for one caller.

### D2. `evaluateChecks` returns `{ checks, unrun }`; `runChecks` delegates
`evaluateChecks(pack, state, ctx, opts)` has the `runChecks` parameters and returns `CheckEvaluation = { checks: CheckResult[]; unrun: string[] }`. On a refresh, `unrun` lists each gate-only check it reported with no valid last result (an unkeyed check always). On a gate request every listed check ran, so `unrun` is `[]`. `runChecks` returns `(await evaluateChecks(...)).checks`, so `stateNow` and tests stay unchanged.

### D3. `ChangeState.gateChecksUnrun?: string[]`
Optional, so the fixtures that build a `ChangeState` keep compiling; `undefined` means unknown and keeps the caveat. Set only by `changeState` (`src/hooks/card-input.ts`), which builds the state `nextStep` reads. `withGateChecks` and `stateNow` stay on `runChecks`: neither forecasts, and the memo carries a gate run into the next card refresh.

### D4. Forecast
`escalationForecast` returns `unrun: state.gateChecksUnrun` as is: the card runs only the active phase's checks and the forecast is only made for the active phase, so no filter is needed. `GateForecast` gains `unrun?: string[]`. `gateReady` on `self` keeps the caveat unless `unrun` is an empty array. The `human` branch is unchanged: a failing memo result is already in `state.checks`.

## Risks / Trade-offs

- [A new session still shows the caveat until the gate runs] → intended; deferred to #58.
- [A memo result reflects the session's environment, not a guaranteed gate outcome] → the sentence says "can pass"; the gate reruns nothing new in-session but `unitCache` already reuses the same results there, so the forecast and the gate agree.
