## 1. Seam and asker: digest and answer reuse

Blocked by: none

- [x] 1.1 Add optional `digest` to `DecideDeps` and `DecisionAsk` in `src/decide/seam.ts`; `decide` copies it into the ask intent
- [x] 1.2 Add an `AskRecorded` result (`{ status: "recorded", outcome, reason }`) to the ask contract; `decide` returns it as `source: human` (design D2)
- [x] 1.3 Add `sameFacts(record, facts)` and `reusableAnswer(marked, point, subject, digest, facts)` to `src/decide/records.ts` (the latest record for the digest, any source, is the candidate; only a `source: human` one with non-null outcome and the same facts is reused; `facts_hash` compared by hash) (design D2, D3)
- [x] 1.4 Add `digest?` to `DecideSnapshot` (`src/interaction/approver.ts`); `decisionRequest` stores it and `applyDecide` writes it into the human record
- [x] 1.5 `createDecisionAsker` returns a reusable answer before the open-request check and dispatch; no digest means no reuse
- [x] 1.6 Tests in `tests/decide/records.test.ts`, `tests/decide/seam.test.ts`, `tests/tools/decide-ask.test.ts` for the decision-seam scenarios (digest in record, reuse, changed facts, changed contract, dismissed, latest wins, `facts_hash`, rule decision ignores a human record)

## 2. Classification and plan_units ask through the approver

Blocked by: 1

- [x] 2.1 `classifyUnits(units, config, ask?)` computes each unit's digest before deciding, passes `{ subject, digest, ask }`, and returns `classified` (rule records only) or `pending` with point, subject and request id (design D4)
- [x] 2.2 A human `tags` outcome that is not a string array refuses the classification
- [x] 2.3 `plan_units` takes the tool `ctx`, builds `createDecisionAsker`, and `classifyPlan` refuses on pending naming the decision and request id, before the merge (design D5)
- [x] 2.4 Replace the "built-in callers stay rule-only" `plan_units` test with the plan_units scenarios: forge ask refuses with nothing merged or written; rerun after `/livespec choose` finishes with no new request and only rule records posted; in-session answer writes one human `difficulty.U1` record; the answer survives a refused run; a non-list `tags` answer refuses; changed tags ask `difficulty` again; `unit-classification` accepts the human record

## 3. unit_amend asks through the approver

Blocked by: 2

- [x] 3.1 `planAmend`/`contractSnapshot` take the asker; `runUnitAmend` builds it with `createDecisionAsker`; pending refuses naming the decision and request id with no amendment request sent
- [x] 3.2 `AmendSnapshot.records` holds rule records only; `applyAmend` posts them as today
- [x] 3.4 `historyUnitIds` skips decision records that carry `request` (answers of a rule ask), so `--add` keeps its id across an ask (design D4a)
- [x] 3.3 Tests in `tests/tools/unit-amend.test.ts`: forge ask refuses with no amendment request; rerun after the answer sends the light gate with the answered difficulty and no new `decide:` request; an added unit keeps its id across an ask
