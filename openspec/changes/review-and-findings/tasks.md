## 1. Routing core: `routeFinding` and the `finding-scope` rule

Blocked by: none

- [ ] 1.1 Add `src/review/route.ts` with `routeFinding(finding, facts)` (design D5) and tests in `tests/review/route.test.ts` for every route, including deleted files, renames and `missed-context` (finding-routing "Finding scope rule")
- [ ] 1.2 Register the `finding-scope` rule in `src/decide/registry.ts` `registerBuiltinRules`, never asking; accept `decisions.finding-scope: { mode: rule }`
- [ ] 1.3 Add `git diff --name-status` reading to `src/engine/git.ts` (`diffNameStatus`) returning paths including deleted files and both rename paths, with a test in `tests/engine/git.test.ts`

## 2. `constraints-not-weakened` check

Blocked by: none

- [ ] 2.1 Add `src/review/standards.ts`: pure check over unified diff text with its own hunk walker for line numbers (design D11), using `isTestFile` from `src/evidence/pending.ts`
- [ ] 2.2 Tests in `tests/review/standards.test.ts` for each scenario of review-phase "Constraints not weakened": added skip/only/x-markers, `@ts-ignore`, `@ts-expect-error` with and without a reason, `eslint-disable`, deleted test file, net removed assertions

## 3. Verifier role contract

Blocked by: none

- [ ] 3.1 Extend `src/subagents/roles.ts` result schema: `verifier` requires `verdict` (`confirmed`|`refuted`); update `src/subagents/validate.ts` and `result.ts` (subagent-dispatch "Return contract")
- [ ] 3.2 Add the `finding` reference parameter to `src/tools/subagent-target.ts`, `subagent-dispatch.ts`, `subagent-packet.ts`, `subagent-record.ts`: required for `verifier`, refused for other roles and for a key naming no aggregate finding
- [ ] 3.3 Resolve the reference into `PacketContext.finding`; make `owningUnit` in `src/subagents/sources-git.ts` add nothing instead of refusing when no unit owns the file (subagent-packets "Context manifest")
- [ ] 3.4 Record verifier runs as `finding-summary` with `role: verifier`, `verifies`, `verdict`, `reason`, id `finding-summary.verify.<key>.<attempt>` in `src/subagents/records.ts`/`run-record.ts`; make unit-finding readers (`unresolvedBlocking`, `unitFindings`, `payload.ts`, `nextRound`, `changeReviewDoneAt`) skip verifier and aggregate records
- [ ] 3.5 Tests in `tests/subagents/` for verifier refusals, verdict validation and the record

## 4. Persona packets and review pack entries

Blocked by: 3

- [ ] 4.1 Add a packet source for `change` and `persona:<name>` reviewers in a new `src/subagents/sources-persona.ts`: `file:agents/<name>.md` from the active content tree, refusing when missing; wire it in `sources.ts`; pin with a test that reviewer packets hold no other reviewer's summary
- [ ] 4.2 `personas()` in `src/subagents/policy.ts` reports `code-reviewer` for a `change` reviewer entry
- [ ] 4.3 Add the `review` phase `subagents` entries to `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json` (flow-pack "Default flow pack", subagent-policy "Default pack entries")
- [ ] 4.4 Make `src/subagents/phase-entries.ts` skip phases whose entries `spec_review` runs (`review`)
- [ ] 4.5 Tests for persona sources, pack contents and the absence of one-by-one review suggestions

## 5. Rebuild marker in unit evidence

Blocked by: none

- [ ] 5.1 Register the `rebuild` marker kind; derive "rebuild" and the amended "receipted, not ticked" in `src/evidence/unit-state.ts` from the latest `rebuild`, receipt and `unit-start`
- [ ] 5.2 `unit_start` accepts green at pre for a rebuild and records verdict `rebuild` (`src/tools/unit-start.ts`, `src/evidence/records.ts` validator); `unit_finish` refuses a rebuild that is not started and names `unit_start`; the `build` next step for a rebuild unit names `unit_start` (`src/engine/next-step.ts`)
- [ ] 5.3 Tests in `tests/evidence/` for "Rebuild starts green" and "Rebuild is not re-ticked"

## 6. Review records, aggregation and finding status

Blocked by: 1, 3, 4

- [ ] 6.1 Add `src/review/records.ts` (registering the `review-run` kind at module load): the `review-run` marker (head, selected, tags, verify results, parent findings, `routed`), the aggregate `finding-summary` shape and queries (latest round, round at HEAD, routed, verifier record of a key)
- [ ] 6.2 Add `src/review/aggregate.ts`: `mergeFindings` (de-duplication by normalized path, line and kind, keeping highest severity and source keys) and `withRoutes` (attach routes and verification need, including `skipped-off` when the verifier entry is off) (design D3, D4)
- [ ] 6.3 Add `src/review/status.ts`: `DISPUTED`, rebutted, question answered, blocking per finding-routing "Finding status"; `review_rounds` derivation and cap (review-phase "Review round cap"); register the gate-only `review-clean` check in `registerBuiltinChecks`, give `CheckGit` a `head()`, add `review-clean` to the `review` phase `checks` and `decisions.finding-scope` to the pack and fixture
- [ ] 6.4 Make `readCounters` in `src/engine/counters.ts` ignore `review_rounds`, and report the derived value through `deriveCommentFacts` in `src/engine/snapshot.ts` with a `reviewRounds` cap
- [ ] 6.5 Make the `unitFindings` packet source include aggregate findings routed to the unit (`src/subagents/sources-records.ts`)
- [ ] 6.6 Tests in `tests/review/` for every aggregate, status and cap scenario, and in `tests/subagents/sources.test.ts` for routed findings in the implementer packet

## 7. Review stages and `spec_review`

Blocked by: 2, 4, 5, 6

- [ ] 7.1 Add `src/review/select.ts` and `src/review/retag.ts` (review-phase "Reviewer selection", "Tags re-checked at review"), posting `tags.review` every round
- [ ] 7.2 Add `src/review/fanout.ts`: concurrent `runDispatch` with `Promise.allSettled`, one shared abort signal
- [ ] 7.3 Add `src/review/round.ts` (the pure stage planner, design D2), `src/review/start.ts` (every unit's `Verify` and red-run parent findings) and `src/review/effects.ts`: rebuild marker and untick, `spec_question` once per key, pull request review comments with marker de-duplication (finding-routing "Route effects", "Pull request review comments")
- [ ] 7.4 Add `src/review/stages.ts` (one function per stage: start, review with every dispatch outcome handled, aggregate with the `finding-scope.review-<n>` decision record, verify, route) and a thin `src/tools/spec-review.ts` that loops planner → stage → state re-read; register it in `src/tools/register.ts`; inline fallback output
- [ ] 7.5 Tests in `tests/tools/spec-review.test.ts` with a fake executor and forge, covering every refusal of review-phase "Review tool" and the issue's "Done when" list: seeded defect routed to its unit, refuted finding `DISPUTED`, out-of-scope non-blocking, cap reached → `spec_stuck`, auth file without a security tag runs the security persona, added `.skip` → `CRITICAL`

## 8. Next steps, gate payload and simplify

Blocked by: 7

- [ ] 8.1 Add the review rules to `src/engine/next-step.ts` in the order of review-phase "Review next steps", including `advance: build` for a pending unit
- [ ] 8.2 Register the `ship` gate payload of finding-routing "Review result at the ship gate" through `registerGatePayload`, and make `subagentFindingsSection` (`src/subagents/payload.ts`) list aggregate `out-of-scope` follow-ups with their keys so a gate records them as shown
- [ ] 8.3 Offer the `simplify` unit before the gate (review-phase "Code simplification unit") and refuse a non-refactor `simplify` in `src/tools/unit-amend.ts` (unit-planning "Simplify unit kind")
- [ ] 8.4 Tests in `tests/engine/next-step.test.ts`, `tests/engine/gate-payload.test.ts` and `tests/tools/unit-amend.test.ts`

## 9. Docs and end-to-end

Blocked by: 8

- [ ] 9.1 Add a Review section to `docs/architecture.md` and drop the "verifier reserved for LS-08" note
- [ ] 9.2 Add an e2e test in `tests/e2e/` that runs a change through `review` with a seeded defect, a refuted finding and a rebuild, ending with an approved `review` gate whose `head_sha` is the reviewed commit
- [ ] 9.3 Run `bun run typecheck` and `bun run test`
