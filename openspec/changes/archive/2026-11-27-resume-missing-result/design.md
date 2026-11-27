## Context

`settle()` (`src/subagents/dispatch.ts`) loops over `interpret()` decisions. A missing or invalid result yields `{ kind: "retry" }` (`src/subagents/result.ts`), which `settle()` handles by calling `launch()` again: a new `service.spawn`, no record. `subagent_answer` (`src/tools/subagent-answer.ts`) calls `settle()` with `retries: 0`, so every answered question gets a fresh respawn budget. The `return` decision already resumes the same child through `returnToChild()`.

## Goals / Non-Goals

**Goals:** resume the same child on a missing result; respawn only as a recorded fallback; at most one live dispatch per target in a session.

**Non-Goals:** how the parent words answers (#67); the missing-sources `return` path; a tool to discard stale questions.

## Decisions

1. **One resume helper.** Generalise `returnToChild()` into `resumeChild(deps, agentId, message)`; both the missing-sources return and the missing-result retry use it. A refused or failed resume returns a reason string.
2. **`retry` decision carries its reason.** `ResultDecision` `retry` becomes `{ kind: "retry"; reason: string }` so the resume message and the `RETRY` record can name it. The cap stays `MISSING_RESULT_RETRIES = 1`: one remedy (resume or fallback respawn) per `settle()` call; the next miss blocks. `DispatchHistory` gains `respawned: boolean`: `runDispatch` starts it false, `subagent_answer` sets it from the forge (`isFallbackChild`: a `RETRY` record names the resumed child as `newAgentId`). When it is true, a failed resume blocks instead of respawning, so answers cannot loop through respawns. Keying on the child, not on `attempt`, keeps the cap right for reviewers and verifiers, whose `attempt` is always 1.
3. **Fallback respawn is recorded.** When the resume fails, `settle()` calls `launch()` once. After the new child's run settles (the forge is never written before a run settles), it posts a `dispatch` comment `{ status: "RETRY", role, unit?, subject?, finding?, agentId: <old>, newAgentId, attempt, reason }` with marker id `dispatch.<scope>.<role>.retry.<newAgentId>`, unique per respawn so no `RETRY` supersedes another. `reason` is plain text: `untrusted()` wrapping happens only when rendering. A cancel during the resume ends the dispatch as cancelled before any launch. Because it carries the old agent id, it also closes any pending question of the old child. `RETRY` is excluded wherever `QUESTION`/`ANSWERED` are (`isResultRecord`, `nextAttempt`) and accepted by `isDispatchData`.
4. **Outcome carries the respawn.** `settle()` returns the outcome with an optional `respawn: { from, to, reason }`; a shared `respawnLine()` is prefixed by both `outcomeText()` and the `spec_review` renderer `outcomeLine()`. Chosen over a new outcome kind so every existing kind still renders unchanged.
5. **In-flight registry.** A module-level `Map<targetKey, agentId>` (value `"(launching)"` until `onLaunch` reports the id) in `src/subagents/in-flight.ts`, key `<issue>|role|unit|subject|finding`. `subagent_dispatch` and `subagent_answer` claim the key before launching or resuming and release it in `finally`; `DispatchDeps.onLaunch(agentId)` updates the id when a child is spawned. Session scope is the process, which matches "in this session"; it is not persisted because a reload has no running tool calls.
6. **Verifier questions carry their finding.** `QUESTION` gains optional `finding` (set from `DispatchRequest.finding`), so `pendingQuestionFor` matches role, unit, subject and finding.
7. **Pending-question guard.** `subagent_dispatch` refuses when `pendingQuestionFor(marked, target)` finds an open `QUESTION` for the same target whose child the executor still knows (`knows()`, moved from `subagent-answer.ts` to `executor.ts`). An unknown child does not block. `QUESTION` records written before this change have no `finding` and never block a verifier dispatch. `spec_review` fan-out stays outside the guard (it dispatches distinct review targets in one call).

8. **Module split.** Resume and retry logic move to `src/subagents/resume.ts` (`resumeChild`, `retryRun`) so `settle` stays a short loop; `subagent_answer` reuses `resumeChild` instead of its own `resume`.

## Risks / Trade-offs

- [A crashed child may not be resumable] → the executor refuses, and the fallback respawn applies, so a crash still gets one fresh attempt.
- [The registry leaks a key if a tool call throws] → release in `finally`.
- [A resumed child redoes work] → the resume message says to submit the result and not to redo finished work.
