# Wire the decision asker into plan_units and unit_amend — Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` (decision-seam, unit-planning) and `design.md`.

**Goal:** `plan_units` and `unit_amend` ask a human when a classification rule asks, reuse a recorded human answer for the same unit digest and facts, and keep one decision record per decision.

**Architecture:** The pure seam carries an optional unit digest into the ask and accepts a `recorded` answer. The forge-aware `createDecisionAsker` looks up a reusable human record (fresh comments) before checking open requests or dispatching. `classifyUnits` takes the asker and returns `pending` or a record for every decision (after D4b); `plan_units` posts only the rule records, `unit_amend` keeps all of them for approval; the two tools turn `pending` into a refusal before any write.

**Tech Stack:** TypeScript, vitest (`bun run test`), `tsc --noEmit` (`bun run typecheck`).

## Global Constraints

- Reuse key: the latest record for point, subject and unit digest (any source, as `currentDecision` picks it) is reused only when it is `source: human`, has outcome not `null` and the same facts (or `facts_hash`).
- A rule that decides by itself is never replaced by a recorded answer.
- Pending classification refuses with the decision id `<point>.<subject>` and the request id. No plan effect happens (no merge, no rule records, `## Units`, `Base` or `livespecBase`; for `unit_amend` no amendment gate request); the classification ask's own comments (`decide:` request, answer, human record) stay.
- No built-in rule is changed to ask; tests register a test rule over `tags` / `difficulty`.

## Review Focus

- Facts after a forge round-trip (YAML parse) compare equal to recomputed facts → Task 1 test "reuses after a forge round-trip".
- Large facts stored as `facts_hash` still reuse → Task 1 test "reuses by facts_hash".
- A newer dismissed record after an older chosen one → no reuse → Task 1 test "latest dismissed wins".
- `difficulty` asked after a changed `tags` answer (same digest) is asked again → covered by "Changed facts ask again" (facts include tags).
- An in-session answer followed by a later refusal (merge conflict) keeps the human record, and the rerun reuses it → Task 2 test "Answer kept across a refused run".

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `DecideDeps` (`src/decide/seam.ts`) | modified | `{ config: unknown; subject: string; digest?: string; ask?: (intent: DecisionAsk) => Promise<AskAnswered \| AskPending \| AskRecorded> }` | no |
| `DecisionAsk` | modified | adds `digest?: string` | no |
| `AskRecorded` | new | `{ status: "recorded"; outcome: unknown; reason: string }` | no |
| `reusableAnswer` (`src/decide/records.ts`) | new | `(marked: MarkedComment[], point: string, subject: string, digest: string, facts: unknown) => DecisionRecord \| undefined` — the latest record for the digest including proposals (after D4b; `currentDecision` skips proposals), accepted only when `source === "human"`, `outcome !== null` and `sameFacts` | no |
| `sameFacts` (`src/decide/records.ts`) | new | `(record: DecisionRecord, facts: unknown) => boolean` | no |
| `DecideSnapshot` (`src/interaction/approver.ts`) | modified | `{ point; subject; facts; digest?: string }` | no (persisted in `request` comments; optional field, old comments stay valid) |
| `decision` record of a human ask | modified | gains `digest` when the subject is a unit | yes (issue comment format; additive) |
| `classifyUnits` (`src/tools/classify-units.ts`) | modified | `(units: { id: string; input: UnitInput }[], config: Pack["decisions"], ask?: DecisionAsker) => Promise<ClassifyResult>` | no |
| `ClassifyResult` | new | `{ status: "classified"; units: RenderableUnit[]; records: DecisionRecord[] } \| { status: "pending"; point: string; subject: string; requestId: string }` | no |
| `classifyPlan` (`src/tools/plan-units-steps.ts`) | modified | `(units: UnitInput[], decisions: Pack["decisions"], ask?: DecisionAsker) => Promise<{ ok: true; plan: ClassifiedUnits } \| { ok: false; message: string }>` | no |
| `runPlanUnits` | modified | `(p: PlanUnitsParams, ctx: ApproverCtx) => Promise<ToolResult<undefined>>` | no |
| `planAmend` (`src/tools/unit-amend.ts`) | modified | `(state: ChangeState, body: string, form: AmendForm, decisions: Pack["decisions"], ask?: DecisionAsker) => Promise<AmendPlan \| { refused: string }>` | no |
| `contractSnapshot` (`src/tools/unit-amend.ts`, module-private) | modified | `(form, units, history, decisions, ask?: DecisionAsker) => Promise<AmendSnapshot \| { refused: string }>` | no |
| `historyUnitIds` (`src/tools/unit-amend.ts`) | modified | same signature; skips `decision` records whose data has a string `request` | no |
| `createDecisionAsker` (`src/tools/decide-ask.ts`) | modified (Task 4) | `(w: WriteContext, state: ChangeState, ctx: ApproverCtx, o?: { proposal?: boolean; now?: () => Date }) => DecisionAsker` | no |
| `DecideSnapshot.proposal` | new (Task 4) | `proposal?: true` | no (persisted, optional) |
| `DecisionRecord.proposal` / `decision` comment | new (Task 4) | `proposal?: true`; validated as boolean when present | yes (issue comment format; additive) |
| `currentDecision` | modified (Task 4) | same signature; skips records with `proposal: true` | no |
| `ClassifyResult.records` | modified (Task 4) | every decision (rule and human); callers filter | no |

---

## Task 1: Seam and asker — digest and answer reuse — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/decide/seam.ts`, `src/decide/records.ts`, `src/interaction/approver.ts`, `src/interaction/complete-decide.ts`, `src/tools/decide-ask.ts`
- Test: `tests/decide/seam.test.ts`, `tests/decide/records.test.ts`, `tests/tools/decide-ask.test.ts`

**Interfaces:**
- Produces: `DecideDeps.digest`, `AskRecorded`, `reusableAnswer`, `sameFacts`, `DecideSnapshot.digest` (see Contracts).

- [ ] **Step 1: failing tests**
  - `seam.test.ts` "a recorded answer decides as human": `ask` returns `{ status: "recorded", outcome: "y", reason: "r" }` → `decide` returns `{ status: "decided", outcome: "y", source: "human", reason: "r", facts }`; "the digest reaches the ask": `deps.digest: "d1"` → intent has `digest: "d1"`.
  - `records.test.ts` `reusableAnswer`: hit for human record with same digest+facts and outcome `y`; miss for other digest, other facts, `source: rule`, outcome `null`; "latest dismissed wins" (chosen then null → undefined); "latest with other facts wins" (older matching `x`, newer other facts → undefined); "newer rule record stops reuse" (human `y` then rule record same digest → undefined); "reuses by facts_hash" (facts > 2,000 chars YAML, record via `decisionComment` + `parseMarked`); "reuses after a forge round-trip" (record parsed back from `decisionComment`).
  - `seam.test.ts` "Rule decision ignores a human record": a rule that decides `x` returns source `rule` and never calls `ask` (the asker holds the reuse, so `decide` with a deciding rule never reaches it).
  - `decide-ask.test.ts` (spec scenarios, `decide("pick", FACTS, { …, digest: "d1", ask })`): "Human record carries the unit digest" (forge + `/livespec choose y` → record `digest: "d1"`); "Recorded answer reused" (after it, a second `decidePick` returns `source: human`, outcome `y`, one `request` comment only); "Changed facts ask again"; "Changed contract asks again" (digest `d2`); "Dismissed answer not reused" (forge choose `y`, then a newer dismissed record for the same digest/facts → new `request`); "Latest human record wins"; "Newer rule record stops reuse"; "Large facts reused by hash" (facts > 2,000 chars).
- [ ] **Step 2:** `bun run test tests/decide tests/tools/decide-ask.test.ts` → the new tests FAIL.
- [ ] **Step 3:** implement: `decide` copies `deps.digest` into the intent and maps `recorded`; `sameFacts` compares `stringify` text, or sha256 of it against `facts_hash` (reuse the hashing in `compactFacts`); `reusableAnswer` calls `currentDecision` and accepts its result only when `source === "human"`, outcome not `null` and `sameFacts`; `decisionRequest` puts `intent.digest` in the snapshot when defined; `applyDecide` writes `digest` when the snapshot has it; `createDecisionAsker` checks `intent.digest !== undefined && reusableAnswer(comments, …)` first and returns `{ status: "recorded", outcome, reason: `reused ${record.reason}` }`.
- [ ] **Step 4:** `bun run test && bun run typecheck` → PASS.
- [ ] **Step 5:** commit `feat(decision-seam): key human asks by unit digest and reuse recorded answers (#24)`.

---

## Task 2: Classification and plan_units ask through the approver — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4
**Difficulty:** Hard
**Blocked by:** Task 1

**Files:**
- Modify: `src/tools/classify-units.ts`, `src/tools/plan-units-steps.ts`, `src/tools/plan-units.ts`, `src/tools/unit-amend.ts` (type-only adaptation to `ClassifyResult`, still no asker)
- Test: `tests/tools/plan-units.test.ts`, `tests/tools/decide-ask.test.ts` (replace the "built-in callers stay rule-only" `plan_units` test)

**Interfaces:**
- Consumes: `DecideDeps.digest`, `createDecisionAsker`, `DecisionAsker`.
- Produces: `ClassifyResult`, `classifyUnits(…, ask?)`, `classifyPlan(…, ask?)`, `runPlanUnits(p, ctx)`.

- [ ] **Step 1: failing tests** — the converge scenarios register `difficulty` as a test rule that asks (options `low`/`medium`/`high`, string outcome); 2.2 registers `tags` asking and checks the refusal for a non-list choice:
  - "Classification asks on the forge" (`[forge]` chain, `difficulty` asks): refusal text contains `difficulty.U1` and the `decide-difficulty-U1.` request id; `git rev-parse HEAD` unchanged; body unchanged; no `decision` comment.
  - "Rerun after a forge answer": `/livespec choose high`, `spec_status` to complete, rerun → success; U1 `Difficulty: high`; one `request` comment; `decision` comments: `tags.U1` (rule) and `difficulty.U1` (human, digest = U1's digest) only.
  - "Classification answered in session" (`[in-session]`, select `high`): written; exactly one `difficulty.U1` record, source `human`.
  - "Human answer satisfies the check": after the rerun, `spec_validate` / `unit-classification` reports no error for U1.
  - "Tags answer that is not a list of tags" (`tags` asks, in-session choice `x`) → refusal text contains `tags.U1` and `not a list of tags`; HEAD and body unchanged.
  - "Answer kept across a refused run": in-session `high`, then merge conflict refusal with the human `difficulty.U1` record present; resolve; rerun → no new select call, U1 `Difficulty: high`.
  - "Changed tags change the difficulty question" (`[forge]`, `difficulty` asks): answer for U1 without extra tags, rerun with `extra_tags: [ui]` (same digest) → refused with a new `decide:difficulty.U1` request.
- [ ] **Step 2:** `bun run test tests/tools/plan-units.test.ts tests/tools/decide-ask.test.ts` → FAIL.
- [ ] **Step 3:** implement `classifyUnits` per design D4: digest from `parsedUnit({ ...input, id, difficulty: "low", tags: [] })` (digest ignores both), `decide(point, facts, { config, subject: id, digest, ask })`; a `pending` result returns `{ status: "pending", point, subject: id, requestId }`; `record()` only for `source: "rule"`; a human `tags` outcome that is not `string[]` throws `decision \`tags.<id>\` answer is not a list of tags`. Keep `classifyOne` and the loop small (one responsibility each).
- [ ] **Step 4:** `classifyPlan` maps pending to `plan_units refused: decision \`<point>.<subject>\` waits for a human answer (request <id>); nothing was merged or written. Rerun plan_units after it is answered.`; `runPlanUnits` takes `ctx`, builds `createDecisionAsker(w, state, ctx)`, passes it; `registerPlanUnits` forwards `ctx` like `registerUnitAmend`. `unit-amend.ts` reads `.status === "classified"` (pending unreachable without asker → treat as refusal).
- [ ] **Step 5:** `bun run test && bun run typecheck` → PASS.
- [ ] **Step 6:** commit `feat(unit-planning): plan_units asks classification through the approver chain (#24)`.

---

## Task 3: unit_amend asks through the approver — implements 3

**Covers:** 3.1, 3.2, 3.3, 3.4
**Difficulty:** Normal
**Blocked by:** Task 2

**Files:**
- Modify: `src/tools/unit-amend.ts`
- Test: `tests/tools/unit-amend.test.ts`

**Interfaces:**
- Consumes: `ClassifyResult`, `classifyUnits(…, ask?)`, `createDecisionAsker`.
- Produces: `planAmend(…, ask?)`, `contractSnapshot(…, ask?)`, `historyUnitIds` (see Contracts).

- [ ] **Step 1: failing tests** (locked plan via `planned()`, then register `difficulty` asking; chain `[forge]`):
  - "Amendment classification asks on the forge": `unit_amend U1` → refusal names `difficulty.U1` and its `decide:` request id; no `amend:` request comment.
  - "Amendment rerun after a forge answer": `/livespec choose high`, `spec_status`, rerun `unit_amend U1` with the same replacement → light gate request sent whose snapshot lines contain `Difficulty: high`, `records` holds only the rule `tags.U1`; no second `decide:` request.
  - "Added unit keeps its id across an ask": `unit_amend --add` → refused on `difficulty.U3`; answer `high`; rerun `--add` with the same unit → snapshot unit `U3`, no second `decide:` request; approve → `unit-classification` no error for U3.
  - `historyUnitIds` unit test: a decision record with `request` is skipped; one without (`tags.U5` rule record, an override) is kept.
  - Helpers: extend `planned()` with an optional `config` (chain) so forge-chain amendments are testable.
- [ ] **Step 2:** `bun run test tests/tools/unit-amend.test.ts` → FAIL.
- [ ] **Step 3:** `historyUnitIds` skips decision records with a string `request` (design D4a). `contractSnapshot` and `planAmend` take `ask?`; pending → `unit_amend refused: decision \`<point>.<subject>\` waits for a human answer (request <id>); no amendment request was sent.`; `runUnitAmend` builds `createDecisionAsker(w, state, ctx)`. `applyAmend` is unchanged (rule records only).
- [ ] **Step 4:** `bun run test && bun run typecheck` → PASS.
- [ ] **Step 5:** commit `feat(unit-planning): unit_amend asks classification through the approver chain (#24)`.

---

## Task 4: Amendment answers are proposals; amendment record dedupe — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4, 4.5
**Difficulty:** Hard
**Blocked by:** Task 3

Added after the final whole-branch review (findings Important 1 and 2); design D4b, D4c.

**Files:**
- Modify: `src/decide/records.ts`, `src/interaction/approver.ts`, `src/interaction/complete-decide.ts`, `src/tools/decide-ask.ts`, `src/tools/classify-units.ts`, `src/tools/plan-units-steps.ts` (or `plan-units.ts`, wherever records are posted), `src/tools/unit-amend.ts`, `src/interaction/complete-amend.ts`
- Test: `tests/decide/records.test.ts`, `tests/tools/decide-ask.test.ts`, `tests/tools/unit-amend.test.ts`, `tests/tools/plan-units.test.ts` (only if an existing assertion changes)

**Interfaces:**
- Produces: `createDecisionAsker(…, o?)`, `DecideSnapshot.proposal`, `DecisionRecord.proposal`, `currentDecision` (skips proposals), `ClassifyResult.records` (all decisions) — see Contracts.

- [ ] **Step 1: failing tests**
  - `records.test.ts` "Proposal record is not current": rule `low` then human `high` with `proposal: true`, same digest → `currentDecision` returns the rule record; `reusableAnswer` with the same facts returns the proposal record.
  - `decide-ask.test.ts`: an asker built with `{ proposal: true }` → after `/livespec choose y` the human record has `proposal: true` and `digest`.
  - `unit-amend.test.ts` "Dismissed amendment keeps the classification": locked U1 `Difficulty: low` (no tags); `difficulty` test rule asks; `unit_amend U1` with `extra_tags: [docs]` (same digest) → forge ask, choose `high`, rerun sends the amendment; dismiss it → body `Difficulty: low`, `unit-classification` no error for U1, and while it was pending too.
  - "Approved amendment applies the answer": same, approve → body `Difficulty: high`; latest effective `difficulty.U1` record is `source: human`, `high`, no `proposal`; check clean.
  - "Rule outcome after a human answer is recorded": history for U1's digest rule `low`, then human `high` (no proposal); rule decides `low` in an approved amendment with the same digest → new rule record `low` posted; check clean.
  - Update "Amendment rerun after a forge answer": snapshot `records` now hold the rule `tags.U1` and the human `difficulty.U1` (`high`, no `proposal`).
- [ ] **Step 2:** focused tests FAIL.
- [ ] **Step 3:** implement per design D4b/D4c. `applyAmend` dedupe: skip a record when `currentDecision` for its point/subject/digest has equal outcome and source, or a `decision` comment equal in point/subject/digest/outcome/source was posted after this request's `answer` comment (find it in `run.marked`). Keep functions small.
- [ ] **Step 4:** `bun run test && bun run typecheck` → PASS.
- [ ] **Step 5:** commit `fix(unit-planning): keep amendment answers as proposals until approval (#24)`.

---

## Scenario → test

decision-seam / Decision seam:
- Rule outcome → `tests/decide/seam.test.ts` "Rule outcome" (existing)
- Rule asks → `tests/decide/seam.test.ts` "Rule asks"; `tests/tools/decide-ask.test.ts` "Rule asks: the human selects in session" (existing)
- Human record carries the unit digest → `tests/tools/decide-ask.test.ts` "Human record carries the unit digest"
- Recorded answer reused → `tests/tools/decide-ask.test.ts` "Recorded answer reused"
- Changed facts ask again → `tests/tools/decide-ask.test.ts` "Changed facts ask again"
- Changed contract asks again → `tests/tools/decide-ask.test.ts` "Changed contract asks again"
- Dismissed answer not reused → `tests/tools/decide-ask.test.ts` "Dismissed answer not reused"
- Newer rule record stops reuse → `tests/tools/decide-ask.test.ts` "Newer rule record stops reuse"; `tests/decide/records.test.ts` "newer rule record stops reuse"
- Latest human record wins → `tests/tools/decide-ask.test.ts` "Latest human record wins"; `tests/decide/records.test.ts` "latest with other facts wins"
- Proposal record is not current → `tests/decide/records.test.ts` "Proposal record is not current"
- Large facts reused by hash → `tests/tools/decide-ask.test.ts` "Large facts reused by hash"; `tests/decide/records.test.ts` "reuses by facts_hash"
- Rule decision ignores a human record → `tests/decide/seam.test.ts` "Rule decision ignores a human record"
- Changed tags change the difficulty question → `tests/tools/plan-units.test.ts` "Changed tags change the difficulty question"

unit-planning / Plan units tool (existing scenarios keep their tests in `tests/tools/plan-units.test.ts`):
- Units written with classification, Base is an ancestor of HEAD, Unknown outcome with an unchanged base, Write conflict keeps the base consistent, Change start still reconciles, Merge conflict, Invalid unit, Locked plan, Non-blocking question does not block plan_units, Reclassified question follows its current class, Applying non-blocking answer blocks plan_units, Non-question requests block whatever their stored mode, Request for a missing question blocks → existing same-named tests in `tests/tools/plan-units.test.ts`
- Classification asks on the forge → `tests/tools/plan-units.test.ts` "Classification asks on the forge"
- Rerun after a forge answer → `tests/tools/plan-units.test.ts` "Rerun after a forge answer"
- Classification answered in session → `tests/tools/plan-units.test.ts` "Classification answered in session"
- Answer kept across a refused run → `tests/tools/plan-units.test.ts` "Answer kept across a refused run"
- Tags answer that is not a list of tags → `tests/tools/plan-units.test.ts` "Tags answer that is not a list of tags"

unit-planning / Unit amendments (existing scenarios keep their same-named tests in `tests/tools/unit-amend.test.ts`):
- Amendment unfreezes, Add and drop, Drop a done unit, Invalid replacement, Drop a depended-on unit, Unit finished while the drop was pending, Blocking question keeps the amendment gate closed, Stuck report keeps the amendment gate closed, Iteration cap keeps the amendment gate closed, Non-blocking question does not block unit_amend, Applying answer blocks unit_amend → existing tests
- Amendment classification asks on the forge → `tests/tools/unit-amend.test.ts` "Amendment classification asks on the forge"
- Amendment rerun after a forge answer → `tests/tools/unit-amend.test.ts` "Amendment rerun after a forge answer"
- Dismissed amendment keeps the classification → `tests/tools/unit-amend.test.ts` "Dismissed amendment keeps the classification"
- Approved amendment applies the answer → `tests/tools/unit-amend.test.ts` "Approved amendment applies the answer"
- Rule outcome after a human answer is recorded → `tests/tools/unit-amend.test.ts` "Rule outcome after a human answer is recorded"
- Added unit keeps its id across an ask → `tests/tools/unit-amend.test.ts` "Added unit keeps its id across an ask"

unit-planning / Unit classification check:
- Tag removed in the body → existing `unit-classification` test in `tests/engine/checks.test.ts`
- Human answer satisfies the check → `tests/tools/plan-units.test.ts` "Rerun after a forge answer" (assertion at its end)
