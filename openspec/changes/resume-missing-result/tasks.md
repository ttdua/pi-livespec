## 1. RETRY dispatch record and per-target pending question

Blocked by: none

- [x] 1.1 Add the `RETRY` variant to `DispatchQuestionData` (`agentId`, `newAgentId`, `reason`, `attempt`), its marker id suffix `.retry`, and accept it in `isDispatchData`
- [x] 1.2 Exclude `RETRY` from settled-run queries (`isResultRecord`, `nextAttempt`) so it is never an attempt or a unit's result
- [x] 1.3 Add optional `finding` to `QUESTION` records and `pendingQuestionFor(marked, target)` returning the open `QUESTION` of a role/unit/subject/finding target
- [x] 1.4 Add `isFallbackChild(marked, agentId)`: a `RETRY` record names the child as `newAgentId`

## 2. Resume the same child on a missing result

Blocked by: 1

- [x] 2.1 Carry the reason in the `retry` decision of `interpret`
- [x] 2.2 Generalise `returnToChild` into `resumeChild(deps, agentId, message)` used by both the return and the retry path
- [x] 2.3 In `settle`, resume the same child once on `retry`; only when the resume is refused or fails launch one new child, post the `RETRY` record after it settles, and return the respawn on the outcome
- [x] 2.4 `outcomeText` states a respawn (old and new agent id, reason) ahead of the outcome
- [x] 2.5 Repro: a child that ends with text only after `subagent_answer` is resumed, not replaced
- [x] 2.6 Cap fallback respawns at one per dispatch (`DispatchHistory.respawned`, set by `subagent_answer` from `isFallbackChild`); a cancel during the resume launches nothing; write `finding` on verifier `QUESTION` records and keep it in `subagent_answer`'s target
- [x] 2.7 `spec_review`'s `outcomeLine` states a respawn too

## 3. One live dispatch per target

Blocked by: 1, 2

- [x] 3.1 Add the in-flight registry (`claim`, `update`, `release`) keyed by target
- [x] 3.2 `subagent_dispatch` refuses while the target is in flight or has a pending question whose child the executor knows, naming the agent id; claims and releases the target around the run
- [x] 3.3 `subagent_answer` refuses while the target is in flight, and claims and releases the target around the resume
