## 1. Shared blocking predicates in the engine

Blocked by: none

- [ ] 1.1 Move `effectiveMode` from `src/engine/next-step.ts` to new `src/engine/request-mode.ts` unchanged, export it, and import it in `next-step.ts`; existing `tests/engine/next-step.test.ts` stays green
- [ ] 1.2 Add `blockingRequests(state)` to `src/engine/request-mode.ts` per design D1 (applying always; pending non-question always whatever its stored mode; pending question blocks unless its question is in the body as non-blocking) with unit tests in new `tests/engine/request-mode.test.ts`
- [ ] 1.3 Export `blockingStateRefusal(state)` from `src/engine/gates.ts` running `blockingQuestion`, `openStuck`, `capReached` in order (design D2), with tests in `tests/engine/gates.test.ts`; `gateRefusal` behaviour and messages unchanged

## 2. plan_units refuses only on blocking requests

Blocked by: 1

- [ ] 2.1 In `src/tools/plan-units.ts` `planRefusal`, replace `openRequests` with `blockingRequests` and say "a blocking request is pending"
- [ ] 2.2 In `tests/tools/plan-units.test.ts`, add "Non-blocking question does not block plan_units" and "Reclassified question follows its current class", "Applying non-blocking answer blocks plan_units", "Non-question requests block whatever their stored mode" and "Request for a missing question blocks"; keep the existing pending-request test

## 3. unit_amend respects blocking state

Blocked by: 1

- [ ] 3.1 In `src/tools/unit-amend.ts` `stateRefusal`, after the lock check add `blockingStateRefusal` prefixed `unit_amend refused: `, then replace `openRequests` with `blockingRequests` (design D3)
- [ ] 3.2 In `tests/tools/unit-amend.test.ts`, add "Blocking question keeps the amendment gate closed", "Stuck report keeps the amendment gate closed", "Iteration cap keeps the amendment gate closed", "Non-blocking question does not block unit_amend" and "Applying answer blocks unit_amend", each asserting no request comment is posted when refused
