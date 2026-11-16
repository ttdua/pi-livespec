# Retrospective — wire-decision-asker-into-unit-tools

## Wins

- The reuse rule was settled in the spec before any code was written (latest record for point, subject and digest; human answer; same facts; not dismissed). Implementation then followed the contracts with one additive deviation.
- The internal spec review and plan review caught real gaps before apply: the "writes nothing" wording was too broad, a newer rule record had to stop reuse, and `--add` needed a stable id.
- The final whole-branch review found two amendment integration bugs that no per-task review could see.

## Misses

- An amendment's human answer took effect before the amendment gate approved it. This was a design gap and needed a user decision plus a fourth plan task (D4b).
- `applyAmend` deduped records against the whole history instead of the current decision (D4c).
- A test added in Task 3 read `card.state.checks` in the `build` phase, where `unit-classification` does not run, so the assertion checked nothing. The Task 4 implementer found this and added a `classificationErrors` helper.

## Plan deviations

- Task 4 was added after the final review, with artifacts revised and re-gated.
- `decisionRequest` gained an optional `proposal` parameter (internal).
- Iteration 2 added a missing `Difficulty: high` assertion and synced plan text with D4b.

## Skill/workflow compliance

- SDD ran with one implementer and one reviewer per task and a whole-branch review; all ruling lines are recorded in apply.md.
- The plannotator gates ran for the brainstorm, the final packet, the revised packet and code review; all were approved.

## Surprises

- `unitDigest` excludes `Difficulty` and `Tags`. That makes digest-keyed answers possible, but it also means an amendment that changes only extra tags keeps the same digest, which is the root of the D4b issue.
- A decision record that carries `request` completes that request (`readRequests`). That made it usable as the marker of an ask answer when computing the next unit id (D4a).

## Promote candidates

- Follow-up issue: a retried amendment with a gate override loses the override in the body (`complete-amend.ts` rewrites the snapshot block, then `applyOverrides` skips).
- Follow-up: the empty `card.state.checks` assertion in the existing "amending U3 writes records…" test; partial THEN coverage for "Tag removed in the body" and the two "writes nothing" scenarios.
- Smoke-test the forge ask path against a live forge before the first built-in rule that asks (LS-08/LS-09).
