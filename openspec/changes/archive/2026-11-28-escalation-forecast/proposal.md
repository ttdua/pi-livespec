## Why

For a covered `self` plan gate the next step always adds "unless a gate-only check fails", even after `spec_gate` ran `verify-red-on-base` in this session and it passed, because the engine cannot tell "not run" from "ran with no error" (#75, W2 of #65). The fix stays in-session; cross-session state is left to LS-12 (#58).

## What Changes

**Gate-only checks without a result**
- From: a gate-only check with no valid last result reports nothing, the same as one that ran with no error.
- To: the engine also reports which gate-only checks it reported have no valid last result.
- Reason: the forecast needs the difference.
- Impact: non-breaking, internal.

**Forecast caveat**
- From: a covered `self` forecast always says "can pass unless a gate-only check fails".
- To: the caveat stays only while some gate-only check of the gate has no valid last result; otherwise "Checks pass; the plan gate can pass."
- Reason: a known passing run is not unknown.
- Impact: next-step text after a passing gate run in the same session.

## Capabilities

### New Capabilities

None.

### Modified Capabilities
- `flow-engine`: "Named checks over LS-02 validators" reports gate-only checks with no valid last result.
- `phase-gates`: "Escalation in the next step" keeps the caveat only for those checks.

## Impact

- `src/engine/registry.ts`, `src/engine/checks.ts`: tell a missing memo from an empty one; report the unrun names.
- `src/engine/state-types.ts`, `src/hooks/card-input.ts`: carry them on the card's change state.
- `src/engine/gate-escalation-facts.ts`, `src/engine/gate-decision.ts`: caveat.
- `CHANGELOG.md`.
- No ledger, forge, refusal or `verify-red-on-base` change.
