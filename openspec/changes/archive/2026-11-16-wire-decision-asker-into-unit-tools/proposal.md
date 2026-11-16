## Why

`plan_units` and `unit_amend` classify units rule-only, so a `tags` or `difficulty` rule that asks a human refuses both tools. Wiring the existing decision asker in is not safe yet: a rerun asks again and never converges after a forge answer, and the human record has no unit digest, so `unit-classification` ignores it. The first built-in rule that asks (LS-08/LS-09) needs this path to work (issue #24).

## What Changes

**Classification asks a human**
- From: `plan_units` and `unit_amend` pass no asker; a rule that asks refuses the tool.
- To: both tools pass the decision asker. An in-session answer is used at once; a pending forge request refuses the tool with the request id, with nothing merged, written or sent.
- Reason: rules must be able to ask during unit planning.
- Impact: non-breaking; no built-in rule asks yet.

**Recorded human answers are reused**
- From: nothing reuses a human answer; every run would ask again.
- To: when a rule asks, a human record for the same point, unit, unit digest and facts with a non-null outcome is used as the answer. A dismissed answer is never reused; the rerun asks again.
- Reason: a forge answer must let the rerun finish.
- Impact: non-breaking.

**Human records carry the unit digest; no duplicate record**
- From: the human `ask` record has no digest; `plan_units` posts one record per unit and point.
- To: the human record carries the unit digest and is the decision record for that unit and point; the tools post rule records only for decisions made by a rule.
- Reason: `unit-classification` must accept the human answer without a second record.
- Impact: non-breaking.

## Capabilities

### New Capabilities

None.

### Modified Capabilities
- `decision-seam`: "Decision seam" gains the unit digest in the ask and the reuse rule for recorded human answers.
- `unit-planning`: "Plan units tool" and "Unit amendments" ask through the approver chain, refuse on a pending ask, and post rule records only; "Unit classification check" accepts the human record.

## Impact

- `src/decide/seam.ts` (ask intent carries the digest; a reused answer), `src/decide/records.ts` (facts comparison).
- `src/tools/decide-ask.ts`, `src/interaction/approver.ts` (`DecideSnapshot.digest`), `src/interaction/complete-decide.ts`.
- `src/tools/classify-units.ts`, `src/tools/plan-units-steps.ts`, `src/tools/plan-units.ts`, `src/tools/unit-amend.ts`.
- Tests: `tests/tools/decide-ask.test.ts`, `tests/tools/plan-units.test.ts`, `tests/tools/unit-amend.test.ts`, seam/records unit tests.
