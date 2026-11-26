# Resume Missing Result Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** A child that ends without a usable result is resumed, not replaced; a fallback respawn is recorded; one live dispatch per target.

**Architecture:** `interpret` keeps deciding `retry`; `settle` turns `retry` into a resume of the same child via a shared `resumeChild`, falling back to one recorded `launch`. A process-level in-flight registry plus the forge's pending `QUESTION` guard `subagent_dispatch`.

**Tech Stack:** TypeScript, vitest (`bun run test` / `bunx vitest run <file>`), `bunx tsc --noEmit`.

## Global Constraints

- `MISSING_RESULT_RETRIES = 1`: one remedy (resume, or fallback respawn) per `settle` call, then `BLOCKED`.
- The forge is never written before the child's run has settled.
- Every child-authored text in tool output stays wrapped with `untrusted()`.

## Review Focus

- A resume that throws (not just refuses) must fall back to a respawn, not block → test in Task 2.
- The registry must release on every exit path (refusal after claim, cancel, throw) → test in Task 3.
- A `RETRY` record must close the old child's pending question, and two respawns must not supersede each other → test in Task 1.
- A user cancel during the resume must not spawn a fallback → test in Task 2.
- A stale question (executor no longer knows the child) must not block a new dispatch → test in Task 3.
- `subagent_answer` resumed run without result must not spawn → repro test in Task 2.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `dispatch` marker data, `RETRY` variant | modified (additive) | `{ status: "RETRY"; role: Role; unit?: string; subject?: ReviewSubject; finding?: string; agentId: string; newAgentId: string; attempt: number; reason: string }`; marker id `dispatch.<scope>.<role>.retry.<newAgentId>`; `reason` is plain text | no (own forge record format) |
| `dispatch` marker data, `QUESTION` variant | modified | adds optional `finding?: string` | no |
| `QuestionTarget` | new | `{ role: Role; unit?: string; subject?: ReviewSubject; finding?: string }` in `src/subagents/records.ts` | no |
| `openQuestions` | new | `openQuestions(marked: MarkedComment[]): QuestionData[]` (open `QUESTION`s, oldest first); `pendingQuestion` = its last | no |
| `pendingQuestionFor` | new | `pendingQuestionFor(marked, t: QuestionTarget): PendingQuestion \| undefined` | no |
| `isFallbackChild` | new | `isFallbackChild(marked, agentId: string): boolean` | no |
| `ResultDecision` retry | modified | `{ kind: "retry"; reason: string; shown: string }`: `reason` plain for the RETRY record and resume message, `shown` untrusted-wrapped for parent-facing BLOCKED reasons (deviation: `shown` added in Task 2 fix round 1 so a blocked fallback keeps the original reason) | no |
| `DispatchHistory` | modified | adds `respawned: boolean` | no |
| `DispatchOutcome` | modified | every variant may carry `respawn?: { from: string; to: string; reason: string }` | no |
| `DispatchDeps.onLaunch` | new | `onLaunch?(agentId: string): void` | no |
| `resumeChild` | new (replaces `returnToChild` and `subagent-answer`'s `resume`) | `resumeChild(deps: Pick<DispatchDeps, "service" \| "signal">, agentId: string, message: string): Promise<RecordLike \| string>` in `src/subagents/resume.ts` | no |
| `respawnLine` | new | `respawnLine(outcome: DispatchOutcome): string` (empty or one line ending in `\n`) in `src/tools/subagent-outcome.ts` | no |
| in-flight registry | new | `src/subagents/in-flight.ts`: `targetKey(issue: number, t: QuestionTarget): string`, `claim(key): string \| undefined` (taken → running agent id or `"(launching)"`; free → claims, returns undefined), `update(key, agentId)`, `release(key)`, `clearInFlight()` (tests) | no |
| `knows` | moved | `knows(service, id): boolean` exported from `src/subagents/executor.ts` | no |
| `subagent_dispatch` / `subagent_answer` refusals | modified | new refusal texts; params unchanged | yes (approved in brainstorm) |

---

## Task 1: RETRY record and question queries — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4
**Difficulty:** Easy
**Blocked by:** none

**Files:** Modify `src/subagents/records.ts`, `src/subagents/validate.ts`, `src/subagents/run-record.ts`; Test `tests/subagents/records.test.ts`.

- [ ] **Step 1: Failing tests** in `tests/subagents/records.test.ts` (`describe("retry records")`), with `retry = { status: "RETRY", role: "implementer", unit: "U1", agentId: "agent-1", newAgentId: "agent-2", attempt: 1, reason: "r" }`:
  - `isDispatchData(retry)` true; without `newAgentId` false; `QUESTION` with `finding: 3` false, with `finding: "c1:0"` true.
  - "Retry record is not a result": only `retry` marked → `nextAttempt(marked, "implementer", "U1") === 1`, `latestDispatch(marked, "U1") === undefined`, `needsContextCount(...) === 0`.
  - `QUESTION` of `agent-1` then `retry` → `pendingQuestion(marked)` undefined.
  - Two RETRY comments (`newAgentId` `agent-2` and `agent-3`, same unit/attempt) both survive `current()`.
  - `pendingQuestionFor(marked, { role: "implementer", unit: "U2" })` finds U2's open question, not U1's; verifier `QUESTION`s with `finding` `c1:0` and `c1:1` each match only their own finding.
  - `isFallbackChild(marked, "agent-2")` true, `"agent-1"` false.
- [ ] **Step 2:** `bunx vitest run tests/subagents/records.test.ts` → FAIL.
- [ ] **Step 3:** Implement in `records.ts`: the `RETRY` variant and `finding?` on `QUESTION`; `dispatchComment` id for RETRY `dispatch.<scope>.<role>.retry.<token(newAgentId)>`; `NON_RUN_STATUSES = ["QUESTION", "ANSWERED", "RETRY"]` used by `isResultRecord` and `nextAttempt`; `openQuestions`, `pendingQuestion` on top of it, `pendingQuestionFor`, `isFallbackChild`. In `validate.ts` a `RETRY` branch and optional string `finding`.
- [ ] **Step 4:** Test file and `bunx tsc --noEmit` → PASS.
- [ ] **Step 5:** Commit `feat(subagents): RETRY dispatch record and per-target question queries`.

## Task 2: Resume instead of respawn — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
**Difficulty:** Hard
**Blocked by:** Task 1

**Files:** Create `src/subagents/resume.ts`; Modify `src/subagents/result.ts`, `src/subagents/dispatch.ts`, `src/tools/subagent-answer.ts`, `src/tools/subagent-outcome.ts`, `src/review/stages.ts`, `tests/subagents/fake-executor.ts`; Test `tests/subagents/dispatch.test.ts`, `tests/tools/subagent-answer.test.ts`, `tests/tools/subagent-dispatch.test.ts` ("outcome text"), the `spec_review` test file that covers `outcomeLine`.

**Interfaces:** Consumes `RETRY`, `isFallbackChild`, `QUESTION.finding` (Task 1). Produces `resumeChild`, `DispatchOutcome.respawn`, `DispatchDeps.onLaunch`, `DispatchHistory.respawned`.

- [ ] **Step 1: Fake executor.** Add `resumes?: ("ok" | "refuse" | "throw")[]` to `FakeExecutorOptions`: each `resume` call shifts one entry (falling back to `resumeRefused`); `"throw"` rejects. Add `factsById?: (id: string, o) => Partial<LaunchFacts> | null` taking precedence over `facts`.
- [ ] **Step 2: Failing tests** in `tests/subagents/dispatch.test.ts` (update `h0` with `respawned: false`; `interpret` crash → `{ kind: "retry", reason: expect.stringContaining("boom") }`):
  - "Crash retried once" (rewrite of "crash retried once with identical hash"): two error records → spawned 1, `resumed` `[{ id: "agent-1", prompt: stringContaining("boom") and "result tool" }]`, outcome `blocked`, posted one `BLOCKED`.
  - "a rejected wait is retried as a crash": spawned 1, resumed 1, outcome `result`.
  - "Resumed child submits its result": records `[{ result: "text" }, { structuredResult: withSources(["answer:Q2"]) }]` → outcome `result`, posted `[DONE]` with `agentId: "agent-1"`, no RETRY.
  - "Refused resume falls back to one new child": `resumes: ["refuse"]`, two error records → spawned 2 with equal `metadata.packet` and prompt; posted statuses `["RETRY", "BLOCKED"]`; RETRY `{ agentId: "agent-1", newAgentId: "agent-2", reason: stringContaining("boom") }` with no `<untrusted>` markup; outcome `blocked` with `respawn: { from: "agent-1", to: "agent-2" }`; `onLaunch` saw `agent-2`.
  - "Resume that throws falls back": `resumes: ["throw"]` → spawned 2, RETRY posted.
  - "Cancel during the resume launches nothing": `resume` aborts the tool signal before resolving → outcome `cancelled`, spawned 1, nothing posted.
  - "Fallback mismatch leaves no RETRY": `resumes: ["refuse"]`, `factsById` mismatching `agent-2` → no RETRY posted, outcome `inline`.
  - "Fallback child is not replaced": `settle(d, request(), first, { ...h0, respawned: true })` with `resumes: ["refuse"]` and a text-only record → spawned 0, outcome `blocked`.
  - A verifier question (request `role: "verifier", finding: "c1:0"`) posts `QUESTION` with `finding: "c1:0"`.
- [ ] **Step 3: Failing tool tests:**
  - `tests/tools/subagent-answer.test.ts` "Missing result after an answer" (repro): records `[{ pendingQuestion: "Which?" }, { result: "I will stop." }, <citing result>]`; dispatch U1, `subagent_answer agent-1 "x"` → spawned 1, resumed ids `["agent-1", "agent-1"]`, latest dispatch `{ agentId: "agent-1", status: "DONE" }`.
  - "One fallback respawn per dispatch": seed a RETRY `{ agentId: "agent-0", newAgentId: "agent-1", unit: "U1", attempt: 1 }`; `resumes: ["ok", "refuse"]`; records `[{ pendingQuestion: "Which?" }, { result: "text" }]`; dispatch U1, answer → spawned 1, text contains `BLOCKED`.
  - "outcome text": an outcome with `respawn` renders `agent-1` and `agent-2` before the outcome line; `outcomeLine` likewise.
- [ ] **Step 4:** `bunx vitest run tests/subagents/dispatch.test.ts tests/tools/subagent-answer.test.ts tests/tools/subagent-dispatch.test.ts` → FAIL.
- [ ] **Step 5: Implement.**
  - `result.ts`: `retryOrBlock` returns `{ kind: "retry", reason }`; `DispatchHistory.respawned`. Keep reasons plain where they feed `retry` (wrap `record.error` and schema errors with `untrusted()` only in the `blocked` reason).
  - `resume.ts`: `resumeChild` (body of today's `returnToChild`, message as parameter); `retryMessage(reason)` = `` `Your run ended without a usable result: ${reason}. Do not redo finished work. Submit your result now with the result tool; if you cannot finish, submit status BLOCKED with reason and evidence.` ``; `retryRun(deps, request, run, reason, seen)` returning `{ kind: "next"; run; record; respawn? } | { kind: "stop"; outcome }`: resume → record ⇒ next; cancelled ⇒ stop cancelled; string and `seen.respawned` ⇒ stop via `finish` blocked; string otherwise ⇒ `launch` (stop outcome passes through), cancelled ⇒ stop, else post RETRY and return next with `respawn`.
  - `dispatch.ts`: export `launch` and `finish` for `resume.ts`; `launch` calls `deps.onLaunch?.(agentId)` after spawn; `settle` loop delegates `retry` to `retryRun` (set `retries + 1`, `respawned` when a respawn happened) and `return` to `resumeChild`; a thin wrapper attaches `respawn` to the returned outcome; `finish` writes `finding` on verifier `QUESTION`s; `runDispatch` starts `respawned: false`.
  - `subagent-answer.ts`: drop `resume` for `resumeChild`; `targetOf` keeps `q.finding`; history `respawned: isFallbackChild(state.marked, p.id)`.
  - `subagent-outcome.ts`: `respawnLine` = `` `Child ${from} could not be resumed (${untrusted(reason)}), so it was replaced by ${to}; a RETRY record names both.\n` ``; `outcomeText` returns `respawnLine(outcome) + <current switch>` (move the switch to a private function). `stages.ts` `outcomeLine` prefixes `respawnLine` to its `line`.
- [ ] **Step 6:** The three files, `bun run test`, `bunx tsc --noEmit` → PASS.
- [ ] **Step 7:** Commit `fix(subagents): resume the same child on a missing result (#66)`.

## Task 3: One live dispatch per target — implements 3

**Covers:** 3.1, 3.2, 3.3
**Difficulty:** Normal
**Blocked by:** Task 1, Task 2

**Files:** Create `src/subagents/in-flight.ts`; Modify `src/subagents/executor.ts`, `src/tools/subagent-dispatch.ts`, `src/tools/subagent-answer.ts`; Test `tests/subagents/in-flight.test.ts`, `tests/tools/subagent-dispatch.test.ts`, `tests/tools/subagent-answer.test.ts` (each with `afterEach(clearInFlight)`).

**Interfaces:** Consumes `pendingQuestionFor`, `QuestionTarget` (Task 1), `DispatchDeps.onLaunch` (Task 2).

- [ ] **Step 1: Failing tests:**
  - `in-flight.test.ts`: `claim(k)` undefined; again `"(launching)"`; after `update(k, "agent-1")` → `"agent-1"`; after `release(k)` undefined. `targetKey` differs by issue, subject (`unit` vs `spec`) and finding.
  - `subagent-dispatch.test.ts` "Second dispatch while one runs": wrap `h.fake.service.wait` with a promise resolved by the test; start dispatch U2 without awaiting; poll until `spawned.length === 1`; dispatch U2 again → `isError`, text contains `agent-1`, spawned 1; resolve; await the first; a third dispatch launches.
  - "Dispatch while a question waits": records `[{ pendingQuestion: "Which?" }]`; dispatch U1; dispatch U1 again → refused, text contains `agent-1` and `subagent_answer`, spawned 1.
  - "Stale question does not block": same with `unknownIds: ["agent-1"]` → spawned 2.
  - Claim released after the pending-question refusal and after a cancelled dispatch (next dispatch launches).
  - `subagent-answer.test.ts`: with `claim(targetKey(issue, { role: "implementer", unit: "U1" }))` held, `subagent_answer agent-1` refuses naming the target, resumes nothing.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `in-flight.ts` (module `Map<string, string>`). Move `knows` to `executor.ts`. In `subagent-dispatch.ts`, extract `guardTarget(w, state, target, service): ToolResult | (() => void)`: claim first (refuse `` `${argsOf(target)} is already running as child ${id}; wait for it or answer it.` ``), then `pendingQuestionFor` + `knows` (release, refuse `` `child ${id} of ${argsOf(target)} waits on an answer: use subagent_answer ${id} "<answer>".` ``); return the release function. Call it right after `findExecutor` succeeds; run the rest in `try/finally release()`; pass `onLaunch: (id) => update(key, id)`. In `subagent-answer.ts`, extract `answerRun` and wrap it with claim (refuse with the same "already running" text), `update(key, p.id)`, `finally release`.
- [ ] **Step 4:** Test files, `bun run test`, `bunx tsc --noEmit` → PASS.
- [ ] **Step 5:** Commit `feat(subagents): one live dispatch per target (#66)`.

---

## Scenario → test

- Second dispatch while one runs → `tests/tools/subagent-dispatch.test.ts` "Second dispatch while one runs"
- Dispatch while a question waits → `tests/tools/subagent-dispatch.test.ts` "Dispatch while a question waits"
- Stale question does not block → `tests/tools/subagent-dispatch.test.ts` "Stale question does not block"
- Crash retried once → `tests/subagents/dispatch.test.ts` "Crash retried once"
- Resumed child submits its result → `tests/subagents/dispatch.test.ts` "Resumed child submits its result"
- Refused resume falls back to one new child → `tests/subagents/dispatch.test.ts` "Refused resume falls back to one new child" + "outcome text"
- Missing result after an answer → `tests/tools/subagent-answer.test.ts` "Missing result after an answer"
- One fallback respawn per dispatch → `tests/tools/subagent-answer.test.ts` "One fallback respawn per dispatch"
- Retry record is not a result → `tests/subagents/records.test.ts` "Retry record is not a result"
- Unchanged scenarios of the modified requirements (Unit role without a unit … Reviewer with an empty subject; Missing required source; Needs context capped; Missing prerequisite …; Discoveries reach the dependent unit; Marker kind registered; Audit scout writes no dispatch record) → their existing tests, unchanged.
