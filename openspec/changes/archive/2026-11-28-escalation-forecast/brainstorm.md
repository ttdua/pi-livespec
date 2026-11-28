## Design Summary

Issue #75, scoped as a fix inside the current design. The direction of LS-12 (#58), which moves state that tools read back into the ledger, is left to #58 and is not anticipated here.

Today the next step forecasts a covered `self` plan gate from the check results the change state holds. A gate-only check such as `verify-red-on-base` reports its last results still valid for the current state from an in-memory memo of the current session, or no result (flow-engine "Named checks over LS-02 validators"). On `main`:

- in the same session, after one `spec_gate plan`, a failing `verify-red-on-base` is already named as an escalation reason (reproduced with the real tools);
- after a run that passed, the next step still says "the plan gate can pass unless a gate-only check fails", because "no result" and "ran with no error" look the same.

The change makes the engine report which gate-only checks have no valid result, and the forecast keeps the caveat only for those. Within a session, after a gate request ran `verify-red-on-base` for the current `Base` and unit digests:

| Memo of the gate's gate-only checks | Next step at a covered `self` gate |
|---|---|
| A valid result fails a waivable check | names the check as an escalation reason (unchanged) |
| Every gate-only check has a valid result with no error | "Checks pass; the plan gate can pass." |
| Some gate-only check has no valid result (not run this session, key changed, or no key) | today's caveat |

Out of scope, left to #58: results across sessions, clones and lanes. A new session still starts with an empty memo (unit-evidence "Verify red on base check": "A new session MUST run the check again"), so the caveat stays there until the gate runs.

Existing requirements this changes:

- **flow-engine "Named checks over LS-02 validators"**: the engine also reports which reported gate-only checks have no valid last result.
- **phase-gates "Escalation in the next step"**: "On `self` it SHALL say the gate can pass unless a gate-only check fails" applies only while a gate-only check of the gate has no valid last result.

## Alternatives Considered

### Alternative A: Tests only, no spec change
- **Approach**: lock today's behaviour with tests and close #75.
- **Pros**: no code change.
- **Cons**: the caveat stays after a known passing run.
- **Why not chosen**: leaves the misleading sentence #75 reports.

### Alternative B: Record gate-only runs in the ledger (`check-run` kind)
- **Approach**: a seventh ledger kind; the state reads gate-only results from it in every session and clone.
- **Pros**: forecasts across sessions and clones.
- **Cons**: adds a ledger kind, changes the "refuse, writing nothing" rule and how answers are validated, ahead of the LS-12 parts that own these decisions.
- **Why not chosen**: a v0.x fix must not steer #58; that work belongs to LS-12e.

## Agreed Approach

The small in-session fix: the memo tells "not run" from "ran with no error", the forecast uses it. No ledger, forge or refusal change.

## Key Decisions

- The forecast never runs a gate-only check and writes nothing.
- A gate-only check without a key never has a valid last result, so a gate with one keeps the caveat.
- Nothing is persisted; cross-session forecasting is deferred to #58.

## Open Questions

None.
