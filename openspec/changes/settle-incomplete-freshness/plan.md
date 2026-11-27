# Settle incomplete freshness Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** The `incomplete` comment and the `Incomplete` line never show unit items the current state contradicts, and skipped or refused updates are visible to the user.

**Architecture:**
- A pure engine module owns the started-item text and reconciles recorded items with `state.evidence.started`.
- `nextStep` uses that module, so the card, `spec_next` and `/livespec next` agree.
- The renderers choose the `(may be stale)` label from the state they already receive.
- `beforeSettle` compares the current items with the recorded ones (design D1), protects the continuation from write failures (D2), and notifies the user through a guarded `ctx.ui.notify` (D4).

**Tech Stack:** TypeScript, Bun, Vitest (`bun run test`), `tsc --noEmit` (`bun run typecheck`).

## Global Constraints

- The started-item text stays exactly `<unit id> is started`, so existing comments keep parsing.
- The label text is exactly `Incomplete (may be stale)`. The unlabelled text stays `Incomplete`.
- `nextStep` stays pure: no I/O and no `hooks/` import in `src/engine/`.
- The settle hook MUST NOT throw into pi, and a child session still never writes.
- No new dependency. No schema or public API change.
- Apply `~/.agents/skills/coding-standards/SKILL.md`: small single-purpose functions. Do not grow `beforeSettle` into a god function; extract the write decision.

## Review Focus

1. **Recorded items reordered but otherwise equal**, for example registered conditions returned in another order: a write is expected (ordered comparison). Pinned in Task 2, step 2.
2. **A foreign or older item text**, such as `U2 started` or `review pending for U2`: it is kept as recorded and never dropped. Pinned in Task 1, step 1.
3. **A unit id that itself contains ` is started`**, or an item like `x is started` for a unit not in the change: it is dropped only when the unit is not in `started`. A non-unit id parses as a unit id and is dropped. This is acceptable, because items are written only by `settleItems`. Pinned in Task 1, step 1.
4. **`ctx.ui.notify` throws** because the UI is gone: the settle still returns its result. Pinned in Task 2, step 6.
5. **A refused write at the continuation settle**: the continuation is still returned. Pinned in Task 2, step 4.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `startedItem` | new | `export function startedItem(unit: string): string` in `src/engine/incomplete-items.ts`; returns `` `${unit} is started` `` | no |
| `reconcileIncomplete` | new | `export function reconcileIncomplete(items: readonly string[], started: Readonly<Record<string, unknown>>): string[]` in `src/engine/incomplete-items.ts`; keeps order, drops an item matching `^(.+) is started$` whose captured id is not a key of `started`, keeps every other item | no |
| `NextStep.incomplete` | modified | type unchanged (`string[]`); value is now `reconcileIncomplete(state.incomplete, state.evidence.started)` | no |
| `incomplete` comment data | unchanged | `{ items: string[]; at: string; head_sha: string }` | no |
| `Incomplete` line text | modified | `Incomplete (may be stale): <items>` when `state.stale \|\| state.readOnly`, else `Incomplete: <items>`, in `renderCard` and `formatStep` | no |
| `incompleteTitle` | new | `export function incompleteTitle(state: Pick<ChangeState, "stale" | "readOnly">): string` in `src/engine/incomplete-items.ts`; returns `Incomplete (may be stale)` when stale or read-only, else `Incomplete`; one owner shared by `renderCard` and `formatStep` (review: duplicated helper) | no |
| `writeDecision` | new | `function writeDecision(recorded: readonly string[], items: readonly string[], asked: boolean): "clear" \| "write" \| "none"` in `src/hooks/settle.ts` (D1 table, ordered equality) | no |
| `tryRecordIncomplete` | new | `async function tryRecordIncomplete(session: Session, ctx: ExtensionContext, state: ChangeState, items: string[]): Promise<void>` in `src/hooks/settle.ts`; wraps only the refusal check and `writeIncomplete`, records and notifies a refusal or a thrown write error, never throws | no |
| `beforeSettle` | modified | `beforeSettle(session: Session, ctx: ExtensionContext, event: AgentBeforeSettleEvent)` (internal) | no |
| settle notification | new | `ctx.ui.notify(\`livespec: the incomplete comment of #${n} was not updated: ${reason}\`, "warning")`, guarded with try/catch | no |

---

## Task 1: Reconciled incomplete items in the step views — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Easy
**Blocked by:** none

**Files:**
- Create: `src/engine/incomplete-items.ts`, `tests/engine/incomplete-items.test.ts`
- Modify: `src/engine/next-step.ts` (around line 420), `src/hooks/settle.ts` (`settleItems`), `src/hooks/phase-card.ts` (around line 100), `src/tools/format-step.ts` (around line 57)
- Test: `tests/engine/next-step.test.ts`, `tests/hooks/phase-card.test.ts`, `tests/tools/format-step.test.ts`

**Interfaces:**
- Produces: `startedItem` and `reconcileIncomplete` (Contracts).

- [ ] **Step 1: Write the failing tests** in `tests/engine/incomplete-items.test.ts`:
  - `reconcileIncomplete(["U2 is started", "U3 is started", "uncommitted changes in the working tree"], { U3: {} })` → `["U3 is started", "uncommitted changes in the working tree"]`
  - `reconcileIncomplete(["U2 is started"], { U2: {} })` → `["U2 is started"]`
  - `reconcileIncomplete(["review pending for U2", "U2 started"], {})` → unchanged (Review Focus 2)
  - `reconcileIncomplete(["x is started"], {})` → `[]` (Review Focus 3)
  - `startedItem("U2")` → `"U2 is started"`
- [ ] **Step 2: Run** `bunx vitest run tests/engine/incomplete-items.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/engine/incomplete-items.ts` per Contracts.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Wire into `nextStep` and `settleItems`, test first.**
  - In `tests/engine/next-step.test.ts`, add `"drops incomplete items of units no longer started"`. The state has `incomplete: ["U2 is started", "U3 is started", "uncommitted changes in the working tree"]` and `evidence.started` with only `U3`. Expect `step.incomplete` to equal `["U3 is started", "uncommitted changes in the working tree"]`.
  - Add `"keeps other items as recorded"`, with `["review pending for U2"]` and no started units.
  - The existing `incomplete: ["U3"]` test still passes, since `U3` is not an `is started` item.
  - Run it and expect FAIL. Then set `incomplete: reconcileIncomplete(state.incomplete, state.evidence.started)` in `next-step.ts`, and build the started items in `settleItems` with `startedItem`. Run it and expect PASS.
- [ ] **Step 6: Label the line, test first.**
  - In `tests/hooks/phase-card.test.ts` under `describe("Incomplete line")`:
    - `"drops a finished unit"`: the state has `incomplete: ["U2 is started"]` and no started unit. Expect the card not to contain `Incomplete`.
    - `"labels possibly stale items"`: the fixture has U1 and U3, not U2, so use U3. The state has `stale: true`, `incomplete: ["U3 is started"]`, and `evidence.started: { U3: <full StartRecord> }` so `tsc` accepts it. Expect the card to contain `` `Incomplete (may be stale): ${untrusted("U3 is started")}` ``.
  - The same label test goes in `tests/tools/format-step.test.ts`, using `formatStep({ ...STEP, incomplete: ["U3 is started"] }, { ...stateFor("build"), stale: true })`, which matches the scenario. Add a second case with `readOnly: true`. `formatStep` takes the step as given, so no reconciliation happens here.
  - Run them and expect FAIL. Then pass the label title to `inlineLine` from `state.stale || state.readOnly` in both renderers. Run them and expect PASS.
- [ ] **Step 7: Run** `bun run test && bun run typecheck`. Expected: all pass.
- [ ] **Step 8: Commit** with `git commit -m "fix(settle-continuation): reconcile incomplete items with started units"`

---

## Task 2: Settle rewrites differing comments and surfaces skipped updates — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5
**Difficulty:** Normal
**Blocked by:** Task 1 (carried from tasks.md: both modify `src/hooks/settle.ts`, and it uses `startedItem`)

**Files:**
- Modify: `src/hooks/settle.ts`
- Test: `tests/hooks/settle.test.ts`

**Interfaces:**
- Consumes: `startedItem` (Task 1).
- Produces: nothing new for other modules.

Test helpers already in `tests/hooks/settle.test.ts`:
- `settler`, `u2Started`, `finishU2`, `incompletes` and `cardOf`.
- `h.start`, `h.finish`, `h.commit` and `h.seed` from `tests/tools/unit-helpers.ts`.

First extend `settler()` to return its ctx: add `ctx: FakeCtx` to `Settler` and return `ctx: main`. Tests read the spy as `s.ctx.ui.notify`, which is the `vi.fn()` from `tests/hooks/fake-pi.ts`. For the #268 tests use `u2Started([U2, U3, U4])` without U1, because a pending U1 would block the advance to `review`. Add U3/U4 specs, with `check3.sh`/`check4.sh` testing `src/u3.ts`/`src/u4.ts`. Only one unit can be started per worktree, so start U3 with `h.start("U3")`, and add U4's start with `h.seed("unit-start", "U4.s", { unit: "U4", digest: unitDigest(u4), verify, pre: { sha: HEAD } })`, with `u4` taken from `await h.units()` and `unitDigest` imported, as `seedRebuild` in `tests/tools/unit-helpers.ts` does.

- [ ] **Step 1: Write the #268 repro test** `"Rewritten at the continuation settle"`:
  - U2 started, then settle twice. The comment lists `U2 is started`.
  - Call `settled()`, then `finishU2`. Start U3 and seed U4's start.
  - The first settle returns `continue: true`.
  - `incompletes(h)[0].data.items` equals `["U3 is started", "U4 is started"]`.
- [ ] **Step 2: Run** `bunx vitest run tests/hooks/settle.test.ts -t "Rewritten at the continuation"`. Expected: FAIL, because the items are still `["U2 is started"]`. That proves the bug. Then add the D1 tests, which fail where today's behaviour differs:
  - `"No first comment before the continuation"`: the first settle with U2 started writes no comment. This passes today; keep it.
  - `"Equal items are not rewritten"`: settle twice, then call `settled()`. Spy `vi.spyOn(h.forge, "updateComment")` and settle twice again. Expect the spy not to have been called. Today it is called, so FAIL.
  - `"Rewritten after the continuation"`: the comment lists U2. In a new prompt, the first settle has U2 started, then U2 is finished and U3 started before the second settle. Expect `["U3 is started"]`.
  - `"reordered items are rewritten"` (Review Focus 1): with a shared `let flip = false`, register `a` returning `flip ? "y" : "x"` and `b` returning `flip ? "x" : "y"`. Settle twice so the comment lists `[x, y]`. Call `settled()`, set `flip = true`, and settle. Expect the items `[y, x]`.
- [ ] **Step 3: Implement D1.** Extract a pure `writeDecision(recorded: readonly string[], items: readonly string[], asked: boolean): "clear" | "write" | "none"` in `src/hooks/settle.ts` that follows the D1 table, with ordered equality. `beforeSettle` calls `recordIncomplete` for `"clear"` with `[]` and for `"write"` with `items`. Run the tests. Expected: PASS, along with the existing settle tests.
- [ ] **Step 4: D2 and the guarded write, test first.** First pass `ctx` into `beforeSettle` and add `notifyWarning(ctx, n, reason)` with try/catch, plus `tryRecordIncomplete` (Contracts). Do not notify from the outer catch, because a failing condition must stay record-only. Then add these tests:
  - `"Failed rewrite keeps the continuation"`: the comment lists U2. `vi.spyOn(h.forge, "updateComment")` rejects. With U3 started, the first settle still returns `continue: true`. `h.session.errors` holds a `settle:` entry, and `notify` was called with `"warning"`.
  - `"a refused write at the continuation settle keeps the continuation"` (Review Focus 5): set `h.session.accountBlock = "blocked"`. This passes before and after the change; it guards against regression.

  Expect the first test to FAIL. Then route both write sites through `tryRecordIncomplete`. Expect PASS.
- [ ] **Step 5: D4, test first.** Add these tests:
  - Extend `"Read-only forge"`, which mocks `isReadOnly` so reads still work: seed the comment with two settles, call `settled()`, then go read-only and settle. Assert that `notify` was called once with a message containing `#${h.n}` and `"read-only"`. Take `before` after the seeding. Replace `expect(await incompletes(h)).toEqual([])` with an assertion that the comment still lists `U2 is started`.
  - In the unreachable-forge test, add `expect(s.ctx.ui.notify).not.toHaveBeenCalled()`. The login is unknown and no own comments are read, which is the accepted limitation in design Risks.
  - `"Stale state is notified"`: once the comment lists U2, take `const card = h.session.card` from a real refresh. Then call `vi.spyOn(h.session, "refresh").mockImplementation(async () => { h.session.card = { ...card, state: { ...card.state, stale: true } }; })`. Settling returns `undefined`, no comment is written, and `notify` is called once.
  - `"Unknown state without items is quiet"`: read-only with no comment. A warning is recorded and `notify` is not called.
  - `"Refused write is notified"`: the comment lists U2, U2 is finished and `accountBlock` is set. The next settle does not edit the comment, records a warning and notifies.

  Expect FAIL where today's behaviour differs. Then call `notifyWarning` in the unknown branch when `card.kind === "change" && card.state.incomplete.length > 0`. Refusals and thrown errors are already notified by `tryRecordIncomplete`. Expect PASS.
- [ ] **Step 6: Guarded notify.** Add the test `"a throwing notify does not break settle"` (Review Focus 4): `s.ctx.ui.notify.mockImplementation(() => { throw new Error("ui gone"); })`, and the settle still resolves, returning `undefined` in the read-only case. Run it and expect PASS.
- [ ] **Step 7: Full #268 sequence.**
  - Extend the step 1 test. Commit `src/u3.ts` and call `h.finish("U3")`, then commit `src/u4.ts` and call `h.finish("U4")`. Finishing has no one-unit-per-worktree rule (`src/evidence/refusals.ts` `RUN_RULES`).
  - Assert the change moved to `review`.
  - Call `settled()`, then `settle()` returns `undefined`.
  - `incompletes(h)[0].data.items` equals `[]`.
  - After `h.session.refresh()`, `cardOf(h)` does not contain `Incomplete`.
- [ ] **Step 8: Run** `bun run test && bun run typecheck`. Expected: all pass.
- [ ] **Step 9: Commit** with `git commit -m "fix(settle-continuation): rewrite differing incomplete comment and surface skipped updates"`

---

## Scenario → test

settle-continuation:
- Incomplete posted and shown → `tests/hooks/settle.test.ts` "Incomplete posted and shown" (existing)
- Cleared after finishing → "Cleared after finishing" (existing)
- Cleared after the phase moved on → "Cleared after the phase moved on" (existing)
- Read-only forge → "Read-only forge" (extended with notify)
- Rewritten at the continuation settle → "Rewritten at the continuation settle" (repro, Task 2)
- No first comment before the continuation → "No first comment before the continuation"
- Equal items are not rewritten → "Equal items are not rewritten"
- Refused write is notified → "Refused write is notified"
- Rewritten after the continuation → "Rewritten after the continuation"
- Failed rewrite keeps the continuation → "Failed rewrite keeps the continuation"
- Stale state is notified → "Stale state is notified"
- Unknown state without items is quiet → "Unknown state without items is quiet"
- Step text labels possibly stale items → `tests/tools/format-step.test.ts` "labels possibly stale items". This covers `spec_next` and `/livespec next`. `spec_status` (`formatState`) renders no `Incomplete` line today, and this change leaves it so.

flow-engine:
- Pure → `tests/engine/next-step.test.ts` existing purity test
- Finished unit dropped from incomplete items → `tests/engine/next-step.test.ts` "drops incomplete items of units no longer started", plus `tests/engine/incomplete-items.test.ts`
- Still-started unit kept → `tests/engine/incomplete-items.test.ts` keep case
- Other items kept as recorded → `tests/engine/next-step.test.ts` "keeps other items as recorded"

context-injection:
- Card contents, Stale card, Registered section, Pending approvals shown, Ignored command shown, Evidence shown, Parked and initiative lines → existing `tests/hooks/phase-card.test.ts` tests (unchanged)
- Incomplete items after a receipt → `tests/hooks/phase-card.test.ts` "drops a finished unit", plus the end of the Task 2 #268 sequence
- Possibly stale incomplete items → `tests/hooks/phase-card.test.ts` "labels possibly stale items"
