# Async Questions Unblock Planning Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** `plan_units` and `unit_amend` refuse only on blocking requests, and `unit_amend` also refuses under the same blocking state as `spec_gate` (issue #17).

**Architecture:** A new pure engine module `src/engine/request-mode.ts` owns request blocking facts. It holds `effectiveMode`, moved from `next-step.ts`, and the new `blockingRequests`. `src/engine/gates.ts` exports `blockingStateRefusal`, built from its existing private rules. The two tools swap `openRequests` for these predicates.

**Tech Stack:** TypeScript, vitest (`bun run test` / `bunx vitest run <file>`), bun.

## Global Constraints

- No change to `spec_gate` rule order or messages, to `nextStep` output, or to `src/interaction/complete-validate.ts`.
- The blocking-state messages are exactly the existing `gates.ts` strings:
  - `Blocking question <id> is open: answer it before requesting the gate.`
  - `Stuck report <id> is unanswered: wait for the human's choice.`
  - `change_iterations reached <n> of <cap>: send a stuck report with spec_stuck first.`
- `unit_amend` prefixes them with `unit_amend refused: `.
- No new dependency; code comments and test names in English.
- Request subjects in tool messages stay wrapped with `untrusted(...)`, as today.

## Review Focus

- A question reclassified after its request was stored: the live class wins. Covered in Task 1 unit tests and Task 2 "Reclassified question follows its current class".
- A non-question request stored `async` by a chain deferral must still block. Covered in Task 1 and Task 2 "Non-question requests block whatever their stored mode".
- A question request whose line was deleted from the body must block. Covered in Task 1 and Task 2 "Request for a missing question blocks".
- An applying answer of a non-blocking question must block. Covered in Task 1, Task 2 and Task 3.
- A refused `unit_amend` must post no `request` comment and open no in-session select. Every Task 3 refusal test asserts both.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `effectiveMode` (`src/engine/request-mode.ts`) | modified (moved from private `next-step.ts`) | `(state: ChangeState, subject: string, stored: unknown) => RequestMode`, body unchanged | no (internal module export) |
| `blockingRequests` (`src/engine/request-mode.ts`) | new | `(state: ChangeState) => { id: string; subject: Subject }[]`, pending then applying, comment order | no |
| `blockingStateRefusal` (`src/engine/gates.ts`) | new | `(state: ChangeState) => string \| undefined`; first of blockingQuestion, openStuck, capReached | no |
| `planRefusal` message | modified | `plan_units refused: a blocking request is pending (<untrusted subjects>); wait for its answer.` | no |
| `stateRefusal` messages | modified | `unit_amend refused: <blockingStateRefusal text>` or `unit_amend refused: a blocking request is pending (<untrusted subjects>); wait for its answer.` | no |

---

## Task 1: Shared blocking predicates in the engine — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/engine/request-mode.ts`
- Modify: `src/engine/next-step.ts` (remove `effectiveMode` and `QUESTION_SUBJECT` if unused; import from `request-mode.ts`)
- Modify: `src/engine/gates.ts` (export `blockingStateRefusal`; `REFUSALS` unchanged)
- Create: `tests/engine/request-mode.test.ts`
- Modify: `tests/engine/gates.test.ts`

**Interfaces:**
- Produces: `effectiveMode`, `blockingRequests` and `blockingStateRefusal`, as in Contracts.

- [ ] **Step 1: Write failing tests** in `tests/engine/request-mode.test.ts`. Use `stateFor` from `tests/helpers/change-state.ts`; its fixture body has Q1 open and blocking, and Q2 answered and non-blocking. Use local `pending(subject, kind, mode)` and `applying(subject)` builders shaped like the ones in `tests/engine/next-step.test.ts:271-281`. Tests:
  - `a pending non-blocking question does not block`: body with `- [ ] Q3 (non-blocking): x` added to `## Questions`, and `pending("question:Q3","question","async")`. Expect `blockingRequests(state)` to be `[]`.
  - `the live class wins over the stored mode`:
    - Q3 non-blocking in the body, request stored `blocking`: expect `[]`.
    - Q1 blocking in the body, request stored `async`: expect `[{ id, subject: "question:Q1" }]`.
  - `a request for a missing question blocks`: `pending("question:Q9","question","async")` with no Q9 in the body. Expect it to be returned.
  - `non-question requests block whatever their stored mode`: `gate:plan`, `amend:1`, `stuck:S1` and `decide:tags.U1`, each stored `async`. Expect all four, in order.
  - `applying requests always block`: `applying("question:Q3")` with Q3 non-blocking. Expect it to be returned, after the pending ones.
- [ ] **Step 2: Add a failing test** to `tests/engine/gates.test.ts`, `describe("blockingStateRefusal")`:
  - `ready("define")` gives `undefined`;
  - `stateFor("define")` gives the Q1 message;
  - `stuckOpen: "S1"` gives the stuck message;
  - `blocking: true, count: 5, cap: 5` gives the cap message.

  Use the exact strings in Global Constraints. With Q1 open and S1 open together, expect the Q1 message, which follows rule order.
- [ ] **Step 3: Run** `bunx vitest run tests/engine/request-mode.test.ts tests/engine/gates.test.ts`. Expected: FAIL (module or export missing).
- [ ] **Step 4: Implement.**
  - Move `effectiveMode` verbatim into `src/engine/request-mode.ts`, with its `question:` subject constant.
  - Add `blockingRequests`. It iterates `state.requests.pending`: a subject not starting with `question:` is kept; a question is kept unless `state.change.questions` has that id with `kind === "non-blocking"`. Then it appends every `state.requests.applying` entry, mapped to `{ id, subject }`.
  - In `gates.ts`, add `export function blockingStateRefusal(state)`. It runs `[blockingQuestion, openStuck, capReached]` over a `RefusalInput` with `{ state }`. Give it a narrowed input type, or make those three rules take `{ state }` only, so no fake pack or target is needed.
  - In `next-step.ts`, import `effectiveMode`.
- [ ] **Step 5: Run** `bunx vitest run tests/engine` and `bun run typecheck`. Expected: PASS, with next-step tests unchanged.
- [ ] **Step 6: Commit** `refactor(engine): share request blocking predicates (#17)`.

---

## Task 2: plan_units refuses only on blocking requests — implements 2

**Covers:** 2.1, 2.2
**Difficulty:** Easy
**Blocked by:** Task 1

**Files:**
- Modify: `src/tools/plan-units.ts` (`planRefusal`, the import of `openRequests` replaced by `blockingRequests`)
- Modify: `tests/tools/plan-units.test.ts` (near the existing `refuses while a request is pending` at line ~340)

**Interfaces:**
- Consumes: `blockingRequests` from Task 1.

- [ ] **Step 1: Write failing tests** in `describe("plan_units")`. Use the existing `planning()` harness. Seed `request` comments with `writeMarked("request", "<token>.lx3k2a", record)` as the existing pending test does, then call `h.session.comments?.invalidate(h.n)`. To change Q lines, edit the body with `h.world.editBodyBehindBack` and then `h.session.refresh()`.
  - `Non-blocking question does not block plan_units`: add `- [ ] Q1 (non-blocking): x` and a pending `question:Q1` request stored `async`. Expect `out.isError` to be false and `## Units` to have 2 units.
  - `Reclassified question follows its current class`:
    - a `question:Q1` request stored `blocking` while Q1 reads `(non-blocking)`: the plan is written;
    - in a fresh harness, a `question:Q2` request stored `async` while Q2 reads `(blocking)` and is open: refused, the text contains `question:Q2`, and the body has no units.
  - `Applying non-blocking answer blocks plan_units`: Q1 non-blocking, the pending `request` comment, plus an `answer` comment with the same id. Use `answerComment` from `src/interaction/requests.ts`, with a valid `AnswerData` and no result comment. Expect a refusal containing `question:Q1`, and no units.
  - `Non-question requests block whatever their stored mode`: a table over `gate:plan`, `amend:1`, `stuck:S1` and `decide:tags.U1`, each stored `async`. Do not seed a `stuck` S1 report comment, so `stuckOpen` stays unset. Each case is refused, the text contains the subject, and there are no units.
  - `Request for a missing question blocks`: a `question:Q9` request stored `async`. Refused.
  - Keep `refuses while a request is pending`, changing only the expected text if needed (it contains `pending`).
- [ ] **Step 2: Run** `bunx vitest run tests/tools/plan-units.test.ts`. Expected: the non-blocking and reclassified-to-non-blocking cases FAIL.
- [ ] **Step 3: Implement.** In `planRefusal`, use `blockingRequests(state)` and the message from Contracts.
- [ ] **Step 4: Run** `bunx vitest run tests/tools/plan-units.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(plan-units): let non-blocking questions through (#17)`.

---

## Task 3: unit_amend respects blocking state — implements 3

**Covers:** 3.1, 3.2
**Difficulty:** Normal
**Blocked by:** Task 1

**Files:**
- Modify: `src/tools/unit-amend.ts` (`stateRefusal`; drop the `openRequests` import if unused, keep `allRequests`)
- Modify: `tests/tools/unit-amend.test.ts`

**Interfaces:**
- Consumes: `blockingRequests` and `blockingStateRefusal` from Task 1.

- [ ] **Step 1: Write failing tests** in `describe("unit_amend")`. Use `planned()`, which gives a locked two-unit plan with an in-session human. Seed comments with `h.world.postComment(h.n, BOT_LOGIN, writeMarked(...))`, then `h.session.comments?.invalidate(h.n)` and `h.session.refresh()`. Add a small `seed` helper. A refusal asserts:
  - `out.isError`;
  - the text;
  - the `request` comments are unchanged by the call: snapshot `ofKind(h, "request")` before `amend` and compare after it, so a seeded fixture request is allowed but no new `amend:` request appears;
  - `h.human.summaries` is empty, so no select was opened;
  - `(await ofKind(h, "amendment"))` is empty.

  Tests:
  - `Blocking question keeps the amendment gate closed`: web-edit `## Questions` to add `- [ ] Q2 (blocking): x`, then `amend({ unit: "U1", replacement: U1 })`. Expect text `unit_amend refused: Blocking question Q2 is open: answer it before requesting the gate.`
  - `Stuck report keeps the amendment gate closed`: seed `writeMarked("stuck","S1",{ where:"x", tried:[], hypothesis:"h", options:[{id:"A",label:"a"},{id:"B",label:"b"}], recommended:"A" })`, then `amend({ add: true, replacement: unit("Extra","src/x.ts","x") })`. Expect text containing `Stuck report S1 is unanswered`.
  - `Iteration cap keeps the amendment gate closed`: seed five `stale` comments with `after_plan: true` (default cap 5), as in `tests/tools/spec-gate.test.ts:349-358`. Then `amend({ unit: "U1", replacement: U1 })`. Expect text containing `send a stuck report with spec_stuck`.
  - `Non-blocking question does not block unit_amend`: web-edit to add `- [ ] Q3 (non-blocking): x` and seed a pending `question:Q3` request stored `async`. Then `amend({ unit: "U1", replacement: U1 })`. Expect `h.human.summaries` to have length 1 and an `amendment` comment to be written.
  - `Applying answer blocks unit_amend`: Q3 non-blocking with `request` and `answer` comments and no result comment. Expect text containing `blocking request is pending` and `question:Q3`, with the refusal asserts.
- [ ] **Step 2: Run** `bunx vitest run tests/tools/unit-amend.test.ts`. Expected: the new refusals FAIL (the tool sends the request), and the non-blocking case FAILs on a pending refusal.
- [ ] **Step 3: Implement.** `stateRefusal` order:
  1. the lock check (unchanged);
  2. `blockingStateRefusal(state)` mapped through `refusal(...)`;
  3. `blockingRequests(state)` with the Contracts message.
- [ ] **Step 4: Run** `bunx vitest run tests/tools/unit-amend.test.ts`, then the full suite with `bun run test` and `bun run typecheck`. Expected: all PASS.
- [ ] **Step 5: Commit** `fix(unit-amend): close the amendment gate under blocking state (#17)`.

---

## Scenario → test

Delta `specs/unit-planning/spec.md`:

**Plan units tool, baseline scenarios** (unchanged, existing tests in `tests/tools/plan-units.test.ts`):
- Units written with classification → `tests/tools/plan-units.test.ts` › `Units written with classification`
- Base is an ancestor of HEAD → `tests/tools/plan-units.test.ts` › `Base is an ancestor of HEAD`
- Unknown outcome with an unchanged base → `tests/tools/plan-units.test.ts` › `Unknown outcome with an unchanged base`
- Write conflict keeps the base consistent → `tests/tools/plan-units.test.ts` › `Write conflict keeps the base consistent`
- Change start still reconciles → `tests/tools/plan-units.test.ts` › `Change start still reconciles`
- Merge conflict → `tests/tools/plan-units.test.ts` › `Merge conflict`
- Invalid unit → `tests/tools/plan-units.test.ts` › `Invalid unit`
- Locked plan → `tests/tools/plan-units.test.ts` › `Locked plan`

**Plan units tool, new scenarios** (`tests/tools/plan-units.test.ts`, Task 2):
- Non-blocking question does not block plan_units → `Non-blocking question does not block plan_units`
- Reclassified question follows its current class → `Reclassified question follows its current class`
- Applying non-blocking answer blocks plan_units → `Applying non-blocking answer blocks plan_units`
- Non-question requests block whatever their stored mode → `Non-question requests block whatever their stored mode`
- Request for a missing question blocks → `Request for a missing question blocks`

**Unit amendments, baseline scenarios** (unchanged, `tests/tools/unit-amend.test.ts`):
- Amendment unfreezes → existing `Amendment unfreezes`
- Add and drop → existing `Add and drop`
- Drop a done unit → existing `Drop a done unit`
- Invalid replacement → existing `Invalid replacement`
- Drop a depended-on unit → existing `Drop a depended-on unit`
- Unit finished while the drop was pending → `tests/interaction/complete.test.ts` › `Unit finished while the drop was pending`

**Unit amendments, new scenarios** (`tests/tools/unit-amend.test.ts`, Task 3):
- Blocking question keeps the amendment gate closed → `Blocking question keeps the amendment gate closed`
- Stuck report keeps the amendment gate closed → `Stuck report keeps the amendment gate closed`
- Iteration cap keeps the amendment gate closed → `Iteration cap keeps the amendment gate closed`
- Non-blocking question does not block unit_amend → `Non-blocking question does not block unit_amend`
- Applying answer blocks unit_amend → `Applying answer blocks unit_amend`
