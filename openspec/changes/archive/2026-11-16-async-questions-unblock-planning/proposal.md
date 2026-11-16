## Why

`plan_units` and `unit_amend` refuse while any request is open, including a non-blocking question that may wait on the forge for days, although issue #5 says other work continues meanwhile (W8). The `unit_amend` light gate also ignores an open blocking question, an unanswered stuck report and a blocking `change_iterations` cap, although a blocking question keeps every gate closed (W9). Fixing both keeps LS-05's promises before LS-06 builds on them.

## What Changes

**Pending request refusal in `plan_units` and `unit_amend`**
- From: both tools refuse while any request is pending or applying.
- To: both refuse only while a blocking request is open. A blocking request is any applying request, any `gate:`, `amend:`, `stuck:` or `decide:` request, or a question request whose question is currently blocking.
- Reason: a pending non-blocking question must not stall planning.
- Impact: non-breaking; fewer refusals.

**Blocking state in the `unit_amend` light gate**
- From: `unit_amend` ignores open blocking questions, unanswered stuck reports and the iteration cap.
- To: `unit_amend` refuses, sending no request, while any of them is in force, with the same reasons as `spec_gate`.
- Reason: every gate stays closed under blocking state.
- Impact: non-breaking for callers; new refusals.

Answer validation of amendments is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities
- `unit-planning`: "Plan units tool" and "Unit amendments" change their pending-request refusal, and "Unit amendments" gains the blocking-state refusals.

## Impact

- `src/tools/plan-units.ts` (`planRefusal`) and `src/tools/unit-amend.ts` (`stateRefusal`).
- `src/engine/gates.ts`: its blocking-question, stuck and cap rules become reusable.
- `src/engine/next-step.ts`: its effective-mode helper moves to a shared engine module, with unchanged behaviour.
- Tests in `tests/tools/plan-units.test.ts`, `tests/tools/unit-amend.test.ts` and the engine tests.
- No new dependency, schema, public API or CLI change.
