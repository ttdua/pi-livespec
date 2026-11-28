# Agent behavior conclusion Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Replace the per-capability human `behavior-change` dialog with agent conclusions recorded at `spec_gate define|review`, checked by the change reviewer and flippable by the human through a structured override on request changes.

**Architecture:** One pure resolver in `src/docs/behavior-change.ts` (`effectiveConclusion` and `latestConclusions`) feeds the check, the define payload, ship durable docs, the reviewer packet and override completion. `spec_gate` keeps its "refusals first, then write, then re-check" shape (design D4), and the asker path is deleted. Overrides reuse the unit-override plumbing: `Answered` field, forge `set` command, dialog tab and a completion effect.

**Tech Stack:** TypeScript (Bun), vitest, `yaml`.

## Global Constraints

- The rationale is one line of at most 300 Unicode code points, non-empty after trimming, and neutralised as agent text (`neutralise` in `src/interaction/briefing.ts` or its existing equivalent).
- Precedence ranks are human `changed` = 3, reviewer `changed` = 2, all others = 1.
- Sources `agent` and `reviewer` are valid only for point `behavior-change`.
- Gate payload heading text: `Behavior conclusions (please check):`.
- Forge command: `/livespec set behavior <capability> changed`; only the value `changed` is accepted.
- Packet source id: `records:behavior-conclusions`.
- The dialog key is `b`.
- `decisions.behavior-change: { mode: rule }` stays valid. No dependency is added.
- Every request still obeys approver-adapters "Interaction contract": approving needs no override step.

## Review Focus

- **Legacy pending `decide:behavior-change.*` request.** The check must name it, and the gate must not post a new request. Covered by a test in Task 1 (`behaviorResults` with an open request) and in Task 2 (no `decide:` request written).
- **Rationale holding `<!--` or a line starting with `/livespec`.** It must be neutralised in the record, the payload and the reviewer packet. Covered by a test in Task 3 (payload) and in Task 2 (record reason).
- **`behavior` passed on a change with no items.** It must be accepted when empty; a non-empty list must be refused as extra capabilities. Covered by a test in Task 2.
- **Renamed file in the diff.** `diffFilesOf` counts both paths, so the item lists both, and the coverage check must use the items as computed. Covered by a test in Task 2 that reuses the existing rename fixture.
- **Forge `set behavior` posted after `/livespec changes`.** It comes after the outcome, so it must not attach (first valid answer wins). Covered by a test in Task 5 (forge-match).

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `DecisionRecord.source` | modified | `"rule" \| "human" \| "agent" \| "reviewer"` | no |
| `BehaviorOutcome` | new | `"unchanged" \| "changed"` | no |
| `BehaviorConclusionInput` | new | `{ capability: string; outcome: BehaviorOutcome; rationale: string }` | no |
| `BehaviorConclusion` | new | `{ outcome: BehaviorOutcome; source: "agent" \| "reviewer" \| "human"; reason: string; files: string[]; ref: string }` (port: `commentId` → `ledger/forge ref`, Task 8) | no |
| `effectiveConclusion` | new | `(marked: MarkedComment[], item: BehaviorItem) => BehaviorConclusion \| undefined` | no |
| `latestConclusions` | new (replaces `latestBehaviorRecords`) | `(marked: MarkedComment[]) => Map<string, BehaviorConclusion>` | no |
| `behaviorConclusionComment` | new | `(item: BehaviorItem, c: { source: "agent" \| "reviewer" \| "human"; outcome: BehaviorOutcome; reason: string; overridden_by?: { by: string; at: string; from: unknown } }) => string` | no |
| `behaviorConclusionComment` (port) | modified (Task 8) | returns `AppendInput` (a ledger entry input), like `decisionComment` on main | no |
| `isBacked` | modified (Task 8) | `(marked, m, record) => boolean` in `src/decide/answered.ts`; also accepts a ledger `human` `behavior-change` entry with `overridden_by` when its `request`'s own forge `answer` is valid, `changes_requested`, and lists the capability in `answer.behaviorOverrides` | no |
| `applyBehaviorOverrides` | new (Task 8 deviation) | `(run: Run, request: string, answer: Answered, snapshot: GateSnapshot) => Promise<void>`; `request` is the gate request id written into the entry | no |
| `ConclusionInput.request` | new (Task 8 deviation) | optional `request?: string` on `ConclusionInput`; the gate request id a human override entry names for `isBacked` | no |
| `resultCounts` rule | modified (Task 8 deviation) | `src/interaction/requests.ts`: a `decision` with `overridden_by` is an effect and never completes a request; other ledger `human` results count only beside the own forge `answer` | no |
| `return-behavior` decision | new | `ResultDecision` gains `{ kind: "return-behavior"; capabilities: string[] }` | no |
| `behaviorPacketData` / `registerPacketBehavior` | new | `behaviorPacketData(ctx: PacketContext) => Promise<Packet["behavior"]>` in `src/docs/behavior-source.ts`; `registerPacketBehavior(fn)` in `src/subagents/sources.ts`, a hook `buildPacket` calls so `subagents/` never imports `docs/` | no |
| `ReviewFacts.behaviorItems` | new | optional `behaviorItems?: BehaviorItem[]` on `ReviewFacts` (`src/engine/gate-payload.ts`), set in `buildRequest` only for target `define` | no |
| `GateSnapshot.behavior` | new | `{ capability: string; files: string[]; outcome: BehaviorOutcome \| null }[] \| undefined`, set for `gate:define` when items exist; it is stored, so forge-match and completion read it | no (stored in `request` comments) |
| `Packet.behavior` | new | `{ items: BehaviorItem[]; effective: Record<string, BehaviorConclusion \| null> } \| undefined`, set by `buildPacket` for `reviewer`/`change` when items exist | no |
| `interpret` | modified | `interpret(record, packet, role, history)`; it reads `packet.behavior` for the dispute check, so the signature is unchanged | no |
| `DispatchHistory.disputeReturns` | new | `number`; a separate counter from `returns` | no |
| `DispatchDeps.afterRecord` / `prepareResult` | new (apply deviation) | optional hooks on `DispatchDeps`: `prepareResult(run, result)` normalises reviewer `behavior` once before `interpret`; `afterRecord(run, result)` posts reviewer records after `recordResult`. Reason: `subagents/` must not import `docs/` | no |
| `interpret` | modified (apply deviation) | gains an optional `prepare?: (r: SubagentResult) => SubagentResult` argument, applied right after the schema check. Reason: final review F1 (normalise once, before the dispute check) | no |
| `FindingSummaryData.behavior` | new (apply deviation) | optional cleaned `BehaviorConclusionInput[]` on reviewer `change` finding-summaries. Reason: final review F2, so lost reviewer records can be replayed idempotently | no (stored in `finding-summary` comments) |
| `validDecisionEntries` | new (apply deviation) | `(marked) => { record: DecisionRecord; ref: string }[]` in `src/decide/records.ts` (port, Task 8). Reason: `BehaviorConclusion.commentId` | no |
| `validateBehaviorParam` | new | `(raw: unknown) => { ok: true; entries: BehaviorConclusionInput[] } \| { ok: false; message: string }` | no |
| `spec_gate` parameter `behavior` | new | `{ capability: string; outcome: "unchanged"\|"changed"; rationale: string }[]`, optional | public (tool API) |
| `BehaviorOverride` | new | `{ capability: string; outcome: "changed" }` | no |
| `Answered.behaviorOverrides` | new | `BehaviorOverride[] \| undefined` | no (stored in `answer` comments) |
| `ApprovalRequest.overridableBehavior` | new | `{ items: { capability: string; outcome: BehaviorOutcome \| null }[] } \| undefined`, derived from `GateSnapshot.behavior` for the adapters | no |
| Forge command `set behavior` | removed (Task 8) | was `/livespec set behavior <capability> changed`; removed when rebasing onto LS-12a, LS-12c (#61) owns forge answers. User decision. | public (forge grammar unchanged vs main) |
| Reviewer result `behavior` | new | optional array of `BehaviorConclusionInput` in the reviewer result schema | public (child contract) |
| Packet source `records:behavior-conclusions` | new | required for `reviewer`/`change` when items exist; text one line per item: `- <cap>: <outcome> (<source>) — <reason>; files: a, b` or `- <cap>: none; files: …` | no |

---

## Task 1: Conclusion records and precedence — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Modify: `src/decide/records.ts`, `src/docs/behavior-change.ts`, `src/ship/context.ts` (import and field mapping only, to keep the build passing), `src/decide/seam.ts` (only if the `Decided.source` type needs widening for compile)
- Test: `tests/docs/behavior-change.test.ts`, `tests/decide/records.test.ts` (it imports `latestBehaviorRecords` at line 6; switch it to `latestConclusions`)
- Keep `behaviorAnswer` and `behaviorSubject` exported: `behavior-ask.ts` imports them until Task 2 deletes it. Task 2 removes `behaviorAnswer` if it is then unused; `behaviorSubject` stays for the legacy open-request message.

**Interfaces:**
- Produces: `BehaviorOutcome`, `BehaviorConclusion`, `effectiveConclusion`, `latestConclusions`, `behaviorConclusionComment`, and the rewritten `behaviorResults(items, marked, phase)` (same signature).

- [ ] **Step 1: Failing tests, records.** In `tests/decide/records.test.ts`, add `"Agent source only for behavior-change"`: a `difficulty.U1` comment with `source: agent` is absent from `validDecisions`, while `behavior-change.rate-limit` with `source: agent` is present.
- [ ] **Step 2: Failing tests, precedence.** In `tests/docs/behavior-change.test.ts`, add one `it` per precedence scenario, with the exact names:
  - "Agent cannot undo a human change"
  - "Agent cannot undo a reviewer dispute"
  - "Adding a file does not undo a human change" (human `changed` with files `[src/limit/cap.ts]`, item with files `[cap.ts, window.ts]`, then agent `unchanged` at the new digest → `changed`/`human`)
  - "Later agent record wins over an earlier agent record"
  - "Old human answer still counts" (a record that carries `request`)
  - "New file needs a new conclusion" → `undefined`
  - "Reviewer cannot undo a human change"
- [ ] **Step 3: Failing tests, rule and check.**
  - "Rule never asks": `decide` with a spy asker; the spy is not called and the outcome is `null`.
  - "Unconcluded item names the parameter": the message contains `behavior` and `spec_gate define`.
  - "Behavior changed without a spec edit": the message names `specs/rate-limit/spec.md` and the source.
  - "Spec updated after a changed conclusion": no item, so no result.
  - A legacy open request: the message also names `decide:behavior-change.rate-limit`.
  - Replace "Rule ask carries descriptions" in `tests/docs/behavior-change.test.ts` (it lives there today) with the test-rule version: register a test rule, ask, and assert the descriptions and the rule briefing.
- [ ] **Step 4: Run.** `bunx vitest run tests/docs/behavior-change.test.ts tests/decide` → FAIL.
- [ ] **Step 5: Implement.**
  - Widen the `source` type. `validDecisions` accepts `agent|reviewer` only when `point === "behavior-change"`.
  - Add the resolver in `behavior-change.ts`. Candidates are records of the capability whose outcome is `unchanged|changed`, where either (digest equals and `sameFacts`) or (rank ≥ 2 and `files` intersects the item's files). Fold in comment order with `rank(next) >= rank(current)` to replace.
  - `latestConclusions` runs the same fold over all of a capability's records.
  - `behaviorChangeRule` returns `{ outcome: null, reason: "concluded by the agent through spec_gate's behavior parameter" }`.
  - `behaviorConclusionComment` builds the `decisionComment` with facts, digest (`behaviorDigest`) and files.
- [ ] **Step 6: Run.** The Step 4 command → PASS; also `bun run typecheck` (callers of `latestBehaviorRecords` will fail; leave `src/ship/context.ts` compiling by switching its import to `latestConclusions` with the same field mapping, since Task 4 owns its tests).
- [ ] **Step 7: Commit.** `feat(durable-doc-checks): behavior conclusions and precedence`

---

## Task 2: spec_gate behavior parameter — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5
**Difficulty:** Hard
**Blocked by:** Task 1

**Files:**
- Create: `src/docs/behavior-param.ts`, `src/docs/behavior-record.ts`
- Modify: `src/tools/spec-gate.ts`, `src/tools/decide-ask.ts`
- Delete: `src/docs/behavior-ask.ts`
- Test: `tests/tools/spec-gate-behavior.test.ts`, `tests/tools/spec-gate.test.ts`, `tests/tools/decide-ask.test.ts`

**Interfaces:**
- Consumes: `effectiveConclusion`, `behaviorConclusionComment`, `changeBehaviorItems` (`behavior-check.ts`).
- Produces: `validateBehaviorParam`, and `recordBehaviorConclusions(w: WriteContext, state: ChangeState, entries: BehaviorConclusionInput[]) => Promise<{ ok: true; posted: boolean } | { ok: false; message: string }>`. `SpecGateParams` gains `behavior?: unknown`.

- [ ] **Step 1: Failing tests.** Rewrite `tests/tools/spec-gate-behavior.test.ts`, keeping the existing harness, with these `it` names:
  - "Two capabilities, no dialog": the approver is called once with subject `gate:define`, and there are two `agent` records.
  - "Missing conclusion": the message names `forge-read`, and there are 0 new comments.
  - "Unknown capability listed": the message names `cache`.
  - "Other refusal writes nothing"
  - "Changed conclusion blocks the same call": the message names `specs/rate-limit/spec.md`, and there is no `gate:define` request.
  - "Same conclusion not re-posted"
  - "Agent conclusion recorded": the record fields (point, subject, source `agent`, outcome, reason, files, digest)
  - "Flow without the check"
  - One test through the registered tool's `execute` (`registerSpecGate` with a fake `pi`) proving that `behavior` reaches `runSpecGate`.
  - "Behavior answer before a refusal"
  - "Rationale too long": 301 code points; the message names `behavior` and `300`.
  - Review Focus: an empty `behavior` with no items passes; a non-empty one with no items is refused; a rename item; a rationale containing `<!--`, whose stored reason does not contain `<!--`.

  In `tests/tools/spec-gate.test.ts`, add "Bad behavior shape on another target" (`spec_gate plan`, outcome `maybe`).
- [ ] **Step 2: Run.** `bunx vitest run tests/tools/spec-gate-behavior.test.ts tests/tools/spec-gate.test.ts` → FAIL.
- [ ] **Step 3: Implement `validateBehaviorParam`** in `behavior-param.ts`: `undefined` → `[]`; otherwise an array of objects with exactly the three keys. Count code points with `[...s].length`. Refusal text: `behavior[<i>].<field> <rule>`.
- [ ] **Step 4: Implement `recordBehaviorConclusions`** in `behavior-record.ts`.
  1. Compute the items.
  2. Compare the capability sets (rename items included, as `changeBehaviorItems` computes them). A missing or extra capability gives the refusal `spec_gate refused: behavior must conclude every capability whose code changed without its spec: missing <a, b>; not a behavior item <c>. Pass behavior: [{ capability, outcome: unchanged|changed, rationale }]; nothing was written.`
  3. Per entry, skip it when the latest `agent` record of the same capability and digest has equal outcome and reason. `reason` is compared against the already-neutralised rationale that `validateBehaviorParam` returns, so text containing `<!--` is not re-posted. Otherwise post `behaviorConclusionComment(item, { source: "agent", … })`.
- [ ] **Step 5: Wire into `spec-gate.ts`.**
  - Validate `behavior` right after `briefingStep`.
  - In `behaviorStep`, replace the `askBehaviorChanges` call with `recordBehaviorConclusions`. Keep the refresh when `posted`.
  - Add `behavior` to the `execute` mapping (`spec-gate.ts:367`, which today passes only `target` and `briefing`) and to the tool's JSON schema, with the description `Your conclusion per capability whose code changed without its spec: unchanged or changed, with a one-line evidence rationale. Required at define and review when the change has such capabilities.`
  - Delete `behavior-ask.ts`. Drop the asker-only `BEHAVIOR_POINT` import path in `decide-ask.ts`, and keep `behaviorFilesOf` only if legacy completion still uses it (grep first).
- [ ] **Step 6: Run.** The Step 2 command plus `bunx vitest run tests/tools/decide-ask.test.ts` → PASS; `bun run typecheck` → 0 errors.
- [ ] **Step 7: Commit.** `feat(phase-gates): spec_gate behavior conclusions replace the human question`

---

## Task 3: Gate payload section — implements 3

**Covers:** 3.1, 3.2
**Difficulty:** Normal
**Blocked by:** Task 1, Task 2 (added: both edit `src/tools/spec-gate.ts`)

**Files:**
- Modify: `src/docs/register.ts`, `src/engine/gate-payload.ts` (`ReviewFacts.behaviorItems`), `src/tools/spec-gate.ts` (`buildRequest`: compute `changeBehaviorItems` once and pass it into `ReviewFacts`)
- Test: `tests/docs/behavior-payload.test.ts` (create)

**Interfaces:**
- Consumes: `effectiveConclusion`, `changeBehaviorItems`.
- Produces: `ReviewFacts.behaviorItems`. The payload function reads `facts.behaviorItems` and `effectiveConclusion(state.marked, item)`, and does no I/O. Task 5 reuses these items for `GateSnapshot.behavior`.

- [ ] **Step 1: Failing tests.**
  - "Behavior conclusions listed": two items. The section starts with `Behavior conclusions (please check):`, followed by lines `- rate-limit: unchanged (agent) — <rationale>; files: 1`.
  - "No behavior section without items"
  - Review Focus: a rationale `<!-- x -->` is rendered neutralised.
  - (The "section before the briefing" assertion lives in Task 5's `forge-text.test.ts` work, so no test file is shared.)
- [ ] **Step 2: Run.** `bunx vitest run tests/docs/behavior-payload.test.ts` → FAIL.
- [ ] **Step 3: Implement** the second `registerGatePayload("define", …)` section. An item with no conclusion renders `- <cap>: none; files: <n>`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `feat(phase-gates): behavior conclusions in the define payload`

---

## Task 4: Ship durable docs — implements 4

**Covers:** 4.1, 4.2
**Difficulty:** Easy
**Blocked by:** Task 1

**Files:**
- Modify: `src/ship/context.ts`, `src/ship/durable-docs.ts` (doc comment only)
- Test: `tests/ship/durable-docs.test.ts`, `tests/ship/context.test.ts`

- [ ] **Step 1: Failing tests.**
  - "Agent conclusion covers the files" (context-level: marked comments with an agent `unchanged` → no confirmation item).
  - "Newer changed record wins", now agent then reviewer.
  - "Protected change of other files"
- [ ] **Step 2: Run.** `bunx vitest run tests/ship` → FAIL.
- [ ] **Step 3: Implement.** `behaviorFacts` maps `latestConclusions` to `{ capability, files, outcome }`. `durable-docs.ts` logic stays as is.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.** `feat(ship-phase): durable docs read behavior conclusions of any source`

---

## Task 5: Human behavior override — implements 5

**Covers:** 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
**Difficulty:** Very Hard
**Blocked by:** Task 1, Task 2 (added: both edit `src/tools/spec-gate.ts`, so Task 2 must land first), Task 3 (added: Task 5 asserts the payload section's position in `forge-text.test.ts`)

**Files:**
- Create: `src/interaction/complete-behavior.ts`, `src/interaction/forge-behavior.ts` (collecting overrides, so `forge-match.ts` does not grow)
- Modify:
  - `src/interaction/approver.ts`, `commands.ts`, `forge-match.ts`, `forge-text.ts`, `in-session.ts`, `complete-gate.ts`
  - `src/interaction/dialog/model.ts`, `state.ts`, `keys.ts`, `view.ts`, `result.ts`
  - `src/tools/spec-gate.ts` (`buildRequest` only)
- Test:
  - `tests/interaction/commands.test.ts`, `forge.test.ts`, `forge-text.test.ts`, `in-session.test.ts`, `complete.test.ts`
  - `tests/interaction/dialog/*.test.ts`

**Interfaces:**
- Consumes: `effectiveConclusion`, `behaviorConclusionComment`.
- Produces: `BehaviorOverride`, `Answered.behaviorOverrides`, `GateSnapshot.behavior`, `ApprovalRequest.overridableBehavior`, `Command { verb: "set-behavior"; capability }`, and `applyBehaviorOverrides(run: Run, answer: Answered, snapshot: GateSnapshot) => Promise<void>`. The items come from `snapshot.behavior`, with no I/O at completion.

- [ ] **Step 1: Failing tests, commands.** In `commands.test.ts`: "Behavior override command parsed", meaning `set behavior rate-limit changed` → `{ verb: "set-behavior", capability: "rate-limit" }`. Its THEN (collected, the request stays pending) gets a second test in `forge.test.ts`. "Behavior override with another value", meaning `unchanged` → error `set behavior accepts only changed`.
- [ ] **Step 2: Failing tests, forge.** In `forge.test.ts`:
  - "Forge override then changes"
  - "Forge override then approve": card warning `behavior overrides apply only with /livespec changes; ignored`.
  - "Unknown capability"
  - "Override on another gate"
  - Review Focus: `set behavior` after `changes` does not attach. Assert that the card shows the existing "already answered" warning text; `matchOne` skips that check only for `verb === "set"`, so `set-behavior` must not join that exemption.
  - The "Forge override then approve" warning is emitted when the approve is matched, not when the `set` is collected.

  In `forge-text.test.ts`: "Behavior override command listed", plus one assertion that the "Behavior conclusions" payload section comes before the briefing.
- [ ] **Step 3: Failing tests, dialog.** In `tests/interaction/dialog/`:
  - "Behavior key hint"
  - "Behavior tab opened with one key"
  - "Override sent with request changes"
  - "Override discarded with approve"
  - "Review shows the override with request changes"
  - Updated "No unit tab without overridable units" (define gate with no items)
- [ ] **Step 4: Failing tests, select fallback.** In `in-session.test.ts`: "Select fallback offers the override".
- [ ] **Step 5: Failing tests, completion.** In `complete.test.ts`:
  - "Human flips a conclusion": human `changed` record with `overridden_by.from: "unchanged"`, then the `stale` comment, then the `gate` comment, in that order.
  - "Superseded answer records no override"
  - "Override completed twice"
- [ ] **Step 6: Run.** `bunx vitest run tests/interaction` → FAIL.
- [ ] **Step 7: Implement the types and request.**
  - Add the types.
  - In `buildRequest`, `gate:define` sets `GateSnapshot.behavior` from Task 3's `behaviorItems` and `effectiveConclusion`. It is stored in the request record; `overridable` is not stored, which is why the snapshot is used.
  - Derive `ApprovalRequest.overridableBehavior` from the snapshot for the in-session adapters.
- [ ] **Step 8: Implement the forge side.**
  - `parseSet` branches on the token `behavior` before the `UNIT_ID` test.
  - `forge-behavior.ts` keeps `Map<requestId, Map<capability, BehaviorOverride>>`. It checks capabilities against `request.data.snapshot.behavior`, rejects non-`gate:define` requests, and attaches overrides only when the matched answer's outcome is `changes_requested`; otherwise it warns. `forge-match.ts` adds only the `set-behavior` case in `targetOf` and the calls.
  - `forge-text` adds the `<details>` line.
- [ ] **Step 9: Implement the dialog.** It mirrors the units tab:
  - `TabName` adds `"behavior"`, `behaviorAvailable`, and a `b` key.
  - The state holds `marked: Set<string>`.
  - `result.ts` emits `behaviorOverrides` only when the outcome is `changes_requested`; the view shows "discarded" otherwise.
- [ ] **Step 10: Implement the `select` fallback.** After a request-changes pick with `overridableBehavior`, show one optional multi-step `select` with "Keep conclusions" first, then one entry per capability whose outcome is not `changed`.
- [ ] **Step 11: Implement completion.** `applyBehaviorOverrides` skips when a record with the same `overridden_by.by/at` exists, and skips capabilities missing from `snapshot.behavior`. `complete-gate.ts` calls it when `!superseded && outcome === "changes_requested" && target === "define"`, before `writeStale`.
- [ ] **Step 12: Run.** `bunx vitest run tests/interaction` → PASS; `bun run typecheck` → 0 errors.
- [ ] **Step 13: Commit in three parts** (each is green on its own): 5a types, snapshot, completion; 5b forge commands and text; 5c dialog and `select` fallback. Messages: `feat(approver-adapters): behavior overrides — <part>`.

---

## Task 6: Reviewer conclusions — implements 6

**Covers:** 6.1, 6.2, 6.3, 6.4, 6.5
**Difficulty:** Hard
**Blocked by:** Task 1

**Files:**
- Modify:
  - `src/subagents/roles.ts`, `src/subagents/result.ts`, `src/subagents/source-types.ts` (`Packet.behavior`)
  - `src/subagents/packet.ts` (`buildPacket` fills `Packet.behavior` for `reviewer`/`change`)
  - `src/subagents/dispatch.ts` (`DispatchHistory.disputeReturns`, and the call after `recordResult`)
  - `src/subagents/sources.ts` (`registerPacketBehavior` hook)
  - `src/tools/subagent-record.ts` (the call after `recordResult`, and the `return-behavior` refusal)
  - `src/tools/subagent-answer.ts` (only the `DispatchHistory` literal gains `disputeReturns: 0`; its results go through `dispatch.ts` `finish`)
  - `src/docs/readers.ts` (register the provider and the hook)
- Create: `src/docs/behavior-source.ts` (packet provider), `src/docs/behavior-review.ts` (`recordReviewerConclusions`, kept out of `run-record.ts`)
- Test: `tests/subagents/roles.test.ts`, `tests/subagents/sources.test.ts`, `tests/subagents/dispatch.test.ts`, `tests/tools/subagent-record.test.ts`

**Interfaces:**
- Consumes: `effectiveConclusion`, `behaviorConclusionComment`, `changeBehaviorItems`.
- Produces:
  - The reviewer result field `behavior?: BehaviorConclusionInput[]`.
  - `Packet.behavior`.
  - `behaviorDisputeMisses(result: SubagentResult, behavior: NonNullable<Packet["behavior"]>) => string[]`: the capabilities that lack a blocking finding at their files. A finding is at file `f` when `location === f || location.startsWith(f + ":")`; add a test with `src/limit/cap.ts:12`.
  - `recordReviewerConclusions(post: (body: string) => Promise<void>, run: RunFacts, result: SubagentResult, packet: Packet) => Promise<void>`. It posts only when `run.role === "reviewer" && run.subject === "change" && completed && !run.advisory`, and ignores unknown capabilities.

- [ ] **Step 1: Failing tests, schema and packet.**
  - `roles.test.ts`: "Reviewer behavior accepted" and "Bad behavior outcome".
  - `sources.test.ts`: "Conclusions in the packet" and "Behavior conclusions required for change review" (`unit` packet without it, and no source when there are no items).
- [ ] **Step 2: Failing tests, recording.**
  - `tests/subagents/dispatch.test.ts` (fake executor; the dispatched path is the only one with returns):
    - "Dispute without a finding": returned once, naming `rate-limit`.
    - "Second miss drops the entry"
    - A missing-source return does not consume the dispute return.
  - `tests/tools/subagent-record.test.ts` (inline path; a dispute miss is a refusal there):
    - "Reviewer disputes unchanged"
    - "Reviewer clears an agent change"
    - "Reviewer confirms"
    - "Entry for another capability"
    - "Reviewer cannot undo a human change": the reviewer `unchanged` record is posted and the check still errors.
    - "Rebuttal does not clear a dispute": uses `finding_rebut`, then asserts that `behaviorResults` still errors.
- [ ] **Step 3: Run.** `bunx vitest run tests/subagents tests/tools/subagent-record.test.ts` → FAIL.
- [ ] **Step 4: Implement the schema and provider.**
  - Add the optional `behavior` items schema to the reviewer schema in `roles.ts`, with `outcome` as an enum.
  - The provider is registered for `reviewer` and returns `[]` unless the subject is `change` and items exist.
  - Format the text per Contracts, with `untrusted: true` because reasons are agent text.
- [ ] **Step 5: Implement the dispute check.**
  - `buildPacket` calls the registered `registerPacketBehavior` hook. `behaviorPacketData` computes the items and effective conclusions once, and both the source text and `Packet.behavior` use them.
  - In `interpret`, when `packet.behavior` is set and `behaviorDisputeMisses` is non-empty and `history.disputeReturns < 1`, return `{ kind: "return-behavior", capabilities }`. The message is `behavior <cap> changed needs a WARNING or CRITICAL finding at one of its files`.
  - `settleLoop` handles the new kind by incrementing `disputeReturns`, and `finish`'s `Exclude<…>` lists it.
  - When `disputeReturns >= 1`, accept the result with those entries dropped and a line appended to `notes`.
  - The inline `subagent_record` path refuses on `return-behavior`, naming the capabilities.
- [ ] **Step 6: Implement recording.** In `src/docs/behavior-review.ts`, `recordReviewerConclusions` posts, for each entry whose outcome differs from `packet.behavior.effective`, a `behaviorConclusionComment(item, { source: "reviewer", … })`. It is called right after `recordResult` in `dispatch.ts` `finish` (case `accept`, with the result `recordResult` returns), which also covers `subagent_answer` and `review/stages.ts`, and in `subagent-record.ts`. It MUST NOT also be called from `subagent-answer.ts`, which would post twice. `run-record.ts` stays unchanged.
- [ ] **Step 7: Run** → PASS; `bun run typecheck` → 0 errors.
- [ ] **Step 8: Commit.** `feat(subagent-dispatch): reviewer behavior conclusions`

---

## Task 7: Docs and final verification — implements 7

**Covers:** 7.1, 7.2, 7.3
**Difficulty:** Easy
**Blocked by:** Task 2, Task 3, Task 4, Task 5, Task 6

**Files:**
- Modify: `README.md` (Define gate section, "Behavior-change question" paragraph), `README.vi.md` (same section), `docs/architecture.md` (behavior-change mentions), `CHANGELOG.md`

- [ ] **Step 1: README.** Replace the paragraph with: the agent concludes each capability with evidence; the gate lists "Behavior conclusions (please check)"; to disagree, request changes and mark the capability with `b` in the dialog or `/livespec set behavior <capability> changed` on the forge. Mirror it in `README.vi.md`.
- [ ] **Step 2: Architecture and CHANGELOG.** Update `docs/architecture.md` references to `behavior-ask.ts`, and add a CHANGELOG entry under Unreleased, marked breaking for the `spec_gate` `behavior` parameter.
- [ ] **Step 3: Verify.** `bun run typecheck` → exit 0; `bun run test` → 0 failed.
- [ ] **Step 4: Commit.** `docs: behavior conclusions replace the human question`

---

## Task 8: Port onto ledger-store — implements 8

**Covers:** 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
**Difficulty:** Very Hard
**Blocked by:** Task 7

The branch is squashed onto `origin/main` (57ab980, ledger-store #79) with text conflicts resolved; this task makes it compile and pass on the ledger.

**Files:**
- Modify: `src/decide/records.ts` (`validDecisionEntries` → `ref`), `src/decide/answered.ts` (`isBacked`), `src/docs/behavior-change.ts`, `src/docs/behavior-record.ts`, `src/docs/behavior-review.ts`, `src/interaction/complete-behavior.ts`, `src/interaction/complete-validate.ts` (keep the supersede guard), `src/tools/subagent-record.ts`, `src/tools/subagent-request.ts`, `src/subagents/dispatch.ts`, `src/review/stages.ts`, `src/interaction/commands.ts`, `src/interaction/forge-match.ts`, `src/interaction/forge-text.ts`
- Delete: `src/interaction/forge-behavior.ts`
- Docs: `README.md`, `README.vi.md`, `docs/architecture.md`, `CHANGELOG.md`
- Test: every test listed in 8.4, plus a new `isBacked` test in `tests/decide/` and "Override without its forge answer" / "No override on the forge"

- [ ] **Step 1: Contracts.** Apply the Contracts rows marked Task 8; run `bun run typecheck` and list the errors.
- [ ] **Step 2: Failing tests.** "Override without its forge answer" (`tests/interaction/complete.test.ts` or `tests/docs/behavior-change.test.ts`): an override entry without a backing answer, and one whose answer lacks the capability, do not count. "No override on the forge" (`tests/interaction/forge.test.ts`): `/livespec set behavior rate-limit changed` warns as unparseable and the request stays pending.
- [ ] **Step 3: Port writers.** Every `post(behaviorConclusionComment(...))` becomes a ledger append (`appendRecord` with `run`/`w`, or `RecordDeps.record`). Replay idempotency reads reviewer entries after the summary by merged-list position, as before.
- [ ] **Step 4: `isBacked`.** Extend as in Contracts; `applyBehaviorOverrides` writes `request: <gate request id>`.
- [ ] **Step 5: Remove the forge override** (8.3).
- [ ] **Step 6: Port tests** (8.4) to `tests/helpers/ledger.ts`; keep every scenario name.
- [ ] **Step 7: Docs** (8.5).
- [ ] **Step 8: Verify.** `bun run typecheck` exit 0; `bunx vitest run` 0 failed; `openspec validate agent-behavior-conclusion` exit 0.
- [ ] **Step 9: Commit.** `refactor(durable-doc-checks): behavior conclusions on the ledger`

---

## Task 9: Narrow the fix to the current gate model — implements 9

**Covers:** 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8
**Difficulty:** Hard
**Blocked by:** Task 8

User decision (2026-11-28): #64 is a v0.1.0 fix and must not reshape the forge ahead of LS-12 (#58). Remove the structured human override and the structured reviewer verdict. Disputes go through request changes and blocking findings (design D2). This task supersedes the Contracts rows for `BehaviorOverride`, `Answered.behaviorOverrides`, `GateSnapshot.behavior`, `ApprovalRequest.overridableBehavior`, `applyBehaviorOverrides`, `isBacked` (modified), `return-behavior`, `DispatchHistory.disputeReturns`, `Packet.behavior`, `behaviorPacketData`/`registerPacketBehavior`, `DispatchDeps.afterRecord`/`prepareResult`, `interpret` (`prepare`), `FindingSummaryData.behavior`, Reviewer result `behavior`, `ConclusionInput.request` and the `resultCounts` rule: none of them remain.

**Files:** as listed in tasks.md 9.1–9.6, plus `src/subagents/rubrics.ts`, `src/docs/behavior-source.ts`, `src/docs/readers.ts`, `src/subagents/sources.ts` (back to main's), `src/subagents/packet.ts` (back to main's).

- [ ] **Step 1:** `git checkout origin/main -- <files of 9.1>`; delete the three files; `bun run typecheck` and list the breakages in the remaining behavior modules.
- [ ] **Step 2: Failing tests** for the four new scenarios (9.5) and the three of "Disputed conclusion not restated" (9.8).
- [ ] **Step 3:** Precedence and source rules (9.2); packet source and rubric (9.3); spec_gate snapshot (9.4).
- [ ] **Step 4:** Remove or port tests of removed scenarios; keep the other scenario names.
- [ ] **Step 5:** Docs (9.6).
- [ ] **Step 6: Verify** (9.7).
- [ ] **Step 7: Commit** `refactor(durable-doc-checks): narrow behavior conclusions to the current gate model`.

---

## Scenario → test

Scenarios of unchanged baseline text inside MODIFIED blocks keep their existing tests (found by name under `tests/`). Re-run them, with no edits expected unless a fixture used the removed ask:
- approver-adapters, "Forge command comments" and "In-session dialog" baselines: `tests/interaction/forge.test.ts`, `poll.test.ts`, `dialog/*.test.ts`.
- decision-seam baselines: `tests/tools/decide-ask.test.ts`, `tests/decide/seam.test.ts`, `tests/decide/records.test.ts`, `tests/tools/plan-units.test.ts`, `tests/tools/unit-amend.test.ts`, `tests/tools/fix-ship.test.ts`.
- phase-gates "Gate tool" and "Gate review payload" baselines: `tests/engine/gates.test.ts`, `tests/tools/spec-gate.test.ts`, `tests/interaction/complete.test.ts`, `tests/evidence/red-on-base.test.ts`, `tests/tools/initiative-propose.test.ts`.
- request-briefing "Forge request text" baselines: `tests/interaction/forge-text.test.ts`.
- ship-phase "Durable docs rule and check" baselines: `tests/ship/durable-docs.test.ts`.
- subagent-dispatch "Return contract" and subagent-packets "Context manifest" baselines: `tests/tools/subagent-dispatch.test.ts`, `tests/subagents/sources.test.ts`, `tests/subagents/packet.test.ts`.

New or changed scenarios:
- Behavior tab opened with one key → `tests/interaction/dialog/host.test.ts` (Task 5)
- No unit tab without overridable units (updated WHEN) → `tests/interaction/dialog/host.test.ts` (Task 5)
- Override sent with request changes → `tests/interaction/dialog/host.test.ts` (Task 5)
- Override discarded with approve → `tests/interaction/dialog/host.test.ts` (Task 5)
- Behavior key hint → `tests/interaction/dialog/host.test.ts` (Task 5)
- Review shows the override with request changes → `tests/interaction/dialog/host.test.ts` (Task 5)
- Select fallback offers the override → `tests/interaction/in-session.test.ts` (Task 5)
- Rule ask carries descriptions (now a test rule) → `tests/docs/behavior-change.test.ts` (Task 1)
- Agent source only for behavior-change → `tests/decide/records.test.ts` (Task 1)
- Rationale too long → `tests/tools/spec-gate-behavior.test.ts` (Task 2)
- Flow without the check → `tests/tools/spec-gate-behavior.test.ts` (Task 2)
- Two capabilities, no dialog → `tests/tools/spec-gate-behavior.test.ts` (Task 2)
- Missing conclusion → `tests/tools/spec-gate-behavior.test.ts` (Task 2)
- Other refusal writes nothing → `tests/tools/spec-gate-behavior.test.ts` (Task 2)
- Legacy request still open → `tests/tools/spec-gate-behavior.test.ts` (final fix wave)
- Changed conclusion blocks the same call → `tests/tools/spec-gate-behavior.test.ts` (Task 2)
- Same conclusion not re-posted → `tests/tools/spec-gate-behavior.test.ts` (Task 2)
- Rule never asks → `tests/docs/behavior-change.test.ts` (Task 1)
- Agent conclusion recorded → `tests/tools/spec-gate-behavior.test.ts` (Task 2)
- Agent cannot undo a human change → `tests/docs/behavior-change.test.ts` (Task 1)
- Agent cannot undo a reviewer dispute → `tests/docs/behavior-change.test.ts` (Task 1)
- Adding a file does not undo a human change → `tests/docs/behavior-change.test.ts` (Task 1)
- Later agent record wins over an earlier agent record → `tests/docs/behavior-change.test.ts` (Task 1)
- Old human answer still counts → `tests/docs/behavior-change.test.ts` (Task 1)
- New file needs a new conclusion → `tests/docs/behavior-change.test.ts` (Task 1)
- Unconcluded item names the parameter → `tests/docs/behavior-change.test.ts` (Task 1)
- Behavior changed without a spec edit → `tests/docs/behavior-change.test.ts` (Task 1)
- Spec updated after a changed conclusion → `tests/docs/behavior-change.test.ts` (Task 1)
- Conclusions in the packet → `tests/subagents/sources.test.ts` (Task 6)
- Reviewer disputes unchanged → `tests/tools/subagent-record.test.ts` (Task 6)
- Dispute without a finding → `tests/subagents/dispatch.test.ts` (Task 6)
- Rebuttal does not clear a dispute → `tests/tools/subagent-record.test.ts` (Task 6)
- Reviewer clears an agent change → `tests/tools/subagent-record.test.ts` (Task 6)
- Second miss drops the entry → `tests/subagents/dispatch.test.ts` (Task 6)
- Reviewer cannot undo a human change → `tests/docs/behavior-change.test.ts` (Task 1, resolver) and `tests/tools/subagent-record.test.ts` (Task 6, record posted)
- Entry for another capability → `tests/tools/subagent-record.test.ts` (Task 6)
- Reviewer confirms → `tests/tools/subagent-record.test.ts` (Task 6)
- Human flips a conclusion → `tests/interaction/complete.test.ts` (Task 5)
- Superseded answer records no override → `tests/interaction/complete.test.ts` (Task 5)
- Override completed twice → `tests/interaction/complete.test.ts` (Task 5)
- Bad behavior shape on another target → `tests/tools/spec-gate.test.ts` (Task 2)
- Behavior answer before a refusal (updated WHEN) → `tests/tools/spec-gate-behavior.test.ts` (Task 2)
- Behavior conclusions listed → `tests/docs/behavior-payload.test.ts` (Task 3)
- No behavior section without items → `tests/docs/behavior-payload.test.ts` (Task 3)
- Agent conclusion covers the files → `tests/ship/context.test.ts` (Task 4)
- Newer changed record wins (updated WHEN) → `tests/ship/durable-docs.test.ts` (Task 4)
- Protected change of other files → `tests/ship/durable-docs.test.ts` (Task 4)
- Reviewer behavior accepted → `tests/subagents/roles.test.ts` (Task 6)
- Bad behavior outcome → `tests/subagents/roles.test.ts` (Task 6)
- Behavior conclusions required for change review → `tests/subagents/sources.test.ts` (Task 6)
- No override on the forge → `tests/interaction/forge.test.ts` (Task 8)
- Override without its forge answer → `tests/interaction/complete.test.ts` (Task 8)
- Agent re-concludes after request changes → `tests/docs/behavior-change.test.ts` (Task 9)
- Rubric names the dispute → `tests/subagents/rubrics.test.ts` (Task 9)
- Reviewer dispute blocks review → `tests/tools/spec-review.test.ts` or `tests/subagents/records.test.ts` (Task 9)
- Human requests changes naming a capability → `tests/tools/spec-gate-behavior.test.ts` (Task 9)
- Scenarios removed in Task 9 (reviewer verdict, human override, approver-adapters, subagent-dispatch) → none
- Same unchanged after a dispute refused → `tests/tools/spec-gate-behavior.test.ts` (Task 9)
- New rationale accepted → `tests/tools/spec-gate-behavior.test.ts` (Task 9)
- Notes that do not name the capability → `tests/tools/spec-gate-behavior.test.ts` (Task 9)
