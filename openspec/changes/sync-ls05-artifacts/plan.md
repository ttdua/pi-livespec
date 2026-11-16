# LS-05 Sync (#20) Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Make the living specs and the archived LS-05 artifacts match the code, fix three small behaviours (pre-lock stale units, `/livespec class` applied once, adapter fallback), and remove dead contract members.

**Architecture:** Pure derivations stay in `src/engine/locks.ts`; command matching stays pure in `src/interaction/forge-match.ts`, with `poll.ts` doing the I/O (posting the new `class` marker). Contract cleanup is type-level plus removing unused members; no stored format changes except the new `class` marker kind.

**Tech Stack:** TypeScript, Bun, Vitest (`bun run test`, `bun run typecheck`), OpenSpec.

## Global Constraints

- Run Bun for every package and test command (`bun run test`, `bun run typecheck`); no npm/pnpm.
- Every `#### Scenario:` name in `specs/` has a test with exactly that name under `tests/`.
- Forge text shown to the agent is wrapped with `untrusted()` exactly once.
- Own marked comments only: markers are read through `filterMarked(…, login)`.
- Commit messages in English, conventional commits (`feat(…)`, `fix(…)`, `refactor(…)`, `docs(…)`, `test(…)`).
- No new runtime dependency.

## Review Focus

- A `class` command whose question is already answered (closed) must not throw or post a marker for a closed question → skip silently, as today. Test in Task 4.
- Request comments already on issues carry `snapshot.digests` and subjects in the old string form → still parse. Test in Task 3.
- A superseded plan gate after a stale must not clear the stale unit → test in Task 1.
- A `stale` comment newer than the plan approval keeps the unit stale (order matters) → test in Task 1.
- Two sessions polling the same `class` command: the second sees the marker from fresh comments and skips → covered by "Class command applied once" reading markers from comments, not session state (Task 4).

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `Approver` | modified | `interface Approver { readonly name: AdapterName; available(): boolean; request(r: ApprovalRequest): Promise<Answered \| Pending \| Deferred> }` — `poll` removed | yes |
| `ApproverUI` | modified | `{ hasUI: boolean; select(title: string, options: string[]): Promise<string \| undefined>; input(title: string, placeholder?: string): Promise<string \| undefined> }` — `confirm` removed | no |
| `GateSnapshot` | modified | `{ target: string; failingWaivable: string[] }` — `digests` removed; readers ignore extra fields on old comments | yes |
| `LockState` | modified | `{ locked: Record<string, string> \| undefined; frozen: string[]; staleUnits: string[]; gates: Record<string, GateResult \| undefined> }` — `stalePhases` removed | yes |
| `Subject` | modified | `` `gate:${string}` \| `amend:${number}` \| `question:Q${number}` \| `stuck:S${number}` \| `decide:${string}` `` in `src/interaction/approver.ts` | yes |
| `isSubject` | new | `isSubject(s: string): s is Subject` in `src/interaction/approver.ts`; used by `asRequestRecord` and `asAnswerData` | no |
| `TypedSnapshot` / `snapshotOf` | new | `type TypedSnapshot = { kind: "gate"; snapshot: GateSnapshot } \| { kind: "amend"; snapshot: AmendSnapshot } \| { kind: "question"; snapshot: QuestionSnapshot } \| { kind: "stuck"; snapshot: StuckSnapshot } \| { kind: "decide"; snapshot: DecideSnapshot }`; `snapshotOf(record: RequestRecord): TypedSnapshot` in `src/interaction/requests.ts` (discriminant derived from the subject prefix; stored yaml unchanged) | no |
| Marker kind `class` | new | id = the command comment id; yaml `{ question: string; class: "blocking" \| "non-blocking" }`; registered with `registerKind("class")` in `src/interaction/approver.ts` | yes |
| `CLASS_KIND` | new | `export const CLASS_KIND = "class"` in `src/interaction/approver.ts` | no |
| `MatchOptions` | modified | `{ marked: MarkedComment[]; appliedClasses?: ReadonlySet<string> }` — command comment ids whose `class` command was applied | yes |
| `ClassChange` | modified | `{ question: string; class: QuestionClass; commentId: string }` | yes |
| `adapterChain` | modified | same signature; a layer counts only when its list is non-empty (project → user → default) | yes |
| Marker `stuck` answer data | modified (doc) | answer id `S<n>-answer`: `{ request; outcome: Outcome; choice: string; notes; by; at; adapter }`; a dismissed answer has `outcome: dismissed` and `choice: ""` | yes |
| Request kind per subject | modified (doc) | `gate:` and `amend:` → `gate`; `question:` → `question`; `stuck:` and `decide:` → `stuck` | yes |

---

## Task 1: Stale units cleared by a plan approval — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/engine/locks.ts`, `src/engine/state-types.ts` (if it re-exports `LockState` fields), `tests/helpers/change-state.ts`, `tests/hooks/phase-card.test.ts` (lines 201, 247, 261), `tests/engine/next-step.test.ts` (`lockWith`, line 286)
- Test: `tests/engine/locks.test.ts`, `tests/e2e/gates-flow.test.ts`

**Interfaces:**
- Produces: `LockState` without `stalePhases` (Contracts).

- [ ] **Step 1: Write failing tests in `tests/engine/locks.test.ts`** (use the file's `stale`, `planGate`, `amendment` helpers; comment order = time order):
  - `"Stale before the first lock"`: `[stale("Q3", ["define", ...LATER], ["U2"]), planGate(digests(change))]` → `staleUnits` is `[]`.
  - `"Identical amendment clears a stale unit"`: `[planGate(locked), stale("Q3", […], ["U3"], true), amendment("edit", "U3", { new: locked.U3 })]` → `staleUnits` is `[]`.
  - `"superseded plan gate does not clear a stale unit"`: `[stale(…, ["U2"]), planGate(d, { superseded: true })]` → `["U2"]`.
  - `"stale after the plan approval stays stale"`: `[planGate(d), stale(…, ["U2"], true)]` → `["U2"]`.
  - Remove every `stalePhases` read in `locks.test.ts` (lines 94, 130, 133, 136) and the field in the expected object at line 173; where a removed assertion was the only check of that test, assert the same fact through `lock.gates` (the stale phase has no valid result) instead.
- [ ] **Step 2:** `bun run test tests/engine/locks.test.ts` → the first test FAILS (U2 still stale).
- [ ] **Step 3: Implement in `src/engine/locks.ts`.** `staleUnitsOf(facts)` clears a unit when any approved amendment for it, or any plan gate with `validApproval(g.data)` (name `PLAN_PHASE`), has `at > s.at`. Remove `stalePhasesOf`, the `stalePhases` field and its line in `deriveLocks`; update the header comment. Remove `stalePhases: []` from `tests/helpers/change-state.ts`, `tests/hooks/phase-card.test.ts` and `lockWith` in `tests/engine/next-step.test.ts`. `rg stalePhases src tests` prints nothing.
- [ ] **Step 4: E2E test `"Stale before the first lock"` in `tests/e2e/gates-flow.test.ts`** with the file's harness: in `plan` before any plan gate, a question answer with `--changes` covering U2 cascades (U2 stale, change in `define`); approve the define gate, then the plan gate (in-session approve) → `card(h).state.lock.staleUnits` is `[]` and `card(h).step.next` does not contain `unit_amend`.
- [ ] **Step 5:** `bun run test tests/engine tests/e2e && bun run typecheck` → PASS.
- [ ] **Step 6: Commit** `fix(unit-planning): clear stale units with a later plan approval`.

---

## Task 2: Adapter chain fallback — implements 2

**Covers:** 2.1, 2.2
**Difficulty:** Easy
**Blocked by:** none

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Replace tests in `tests/config.test.ts`:**
  - Delete "present project setting wins even when empty…" and "project list of only unknown names falls back to the default source, not the user chain".
  - Add `"Project list with only unknown names"`: project `interaction: { adapter: [slack] }`, user `[forge]` → `config.warnings` has an entry containing `slack`; `adapterChain(config)` is `{ chain: ["forge"], source: "user" }`.
  - Add `"Empty project list"`: project `[]`, user `[forge]` → `{ chain: ["forge"], source: "user" }`.
  - Add `"Every list empty"`: project `[]`, user `[]` → `{ chain: ["in-session"], source: "default" }`.
- [ ] **Step 2:** `bun run test tests/config.test.ts` → the first two new tests FAIL.
- [ ] **Step 3:** In `adapterChain`, take the first of project list, user list whose length > 0; otherwise the default.
- [ ] **Step 4:** `bun run test tests/config.test.ts tests/interaction/doctor.test.ts` → PASS.
- [ ] **Step 5: Commit** `fix(approver-adapters): fall back past an empty adapter list`.

---

## Task 3: Approver contract cleanup — implements 3

**Covers:** 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
**Difficulty:** Hard
**Blocked by:** Task 1 (added: Task 3's typecheck fixes may touch `tests/engine/next-step.test.ts` and `tests/engine/gates.test.ts`, which Task 1 also edits; running them in sequence avoids two writers on one file)

**Files:**
- Modify: `src/interaction/approver.ts`, `src/interaction/forge.ts`, `src/interaction/in-session.ts`, `src/interaction/requests.ts`, `src/interaction/complete.ts`, `src/interaction/complete-validate.ts`, `src/interaction/complete-gate.ts`, `src/interaction/complete-amend.ts`, `src/interaction/complete-question.ts`, `src/interaction/complete-stuck.ts`, `src/interaction/complete-decide.ts`, `src/interaction/waive-rule.ts` (if it reads the snapshot), `src/tools/approver-for.ts`, `src/tools/spec-gate.ts`, `src/hooks/session.ts`, and any call site the typecheck flags for `Subject`
- Test: `tests/interaction/forge.test.ts`, `tests/interaction/in-session.test.ts`, `tests/interaction/requests.test.ts`, `tests/interaction/complete.test.ts`, `tests/interaction/poll.test.ts`, `tests/tools/unit-amend.test.ts`, `tests/tools/decide-ask.test.ts`, `tests/engine/gates.test.ts` (`pendingGate` subject typing), test doubles with `confirm`

**Interfaces:**
- Produces: `Approver`, `ApproverUI`, `GateSnapshot`, `Subject`, `isSubject`, `TypedSnapshot`, `snapshotOf` (Contracts).

- [ ] **Step 1: Port every `.poll()` caller in tests** (`rg -n "\.poll\(" tests`). In `tests/interaction/forge.test.ts` and `tests/interaction/complete.test.ts` (`forgeAnswer` at line 105, tests at lines 184 and 293), replace `approver.poll(id)` with a local test helper `matchedAnswer(world, n, id)` that reads comments, calls `readPermissions(forge, commandAuthors(comments, pending))` and returns `matchCommands(pending, comments, perms, { marked }).matches[0]?.answer`; keep every assertion, including permission-lookup counts (they still go through `readPermissions`). Delete the in-session `poll` stub test in `tests/interaction/in-session.test.ts`. Run `bun run test tests/interaction && bun run typecheck` → PASS (still against old code).
- [ ] **Step 2: Remove `poll`** from `Approver`, `createForgeApprover`, the in-session approver; drop imports left unused. Remove `confirm` from `ApproverUI`, `uiOf` in `approver-for.ts`, the adapter in `hooks/session.ts`, and `confirm:` from test doubles. Remove `digests` from `GateSnapshot`, from `spec-gate.ts` (and `unitDigests` if unused), and from test fixtures.
- [ ] **Step 3: Failing tests in `tests/interaction/requests.test.ts`:**
  - `"old request comment with snapshot digests still parses"`: a `request` marker whose snapshot is `{ target: "plan", digests: { U1: "a" }, failingWaivable: [] }` appears in `readRequests(…).pending`.
  - `"request with an unknown subject prefix is ignored"`: subject `"deploy:x"` → not in `pending`.
  - `"snapshotOf discriminates by subject"`: `snapshotOf` of `gate:plan`, `amend:1`, `question:Q1`, `stuck:S1`, `decide:tags.U1` records gives kinds `gate`, `amend`, `question`, `stuck`, `decide`.
- [ ] **Step 4: Implement** `Subject` (template literal), `isSubject` (regex per prefix: `^gate:.+$`, `^amend:\d+$`, `^question:Q\d+$`, `^stuck:S\d+$`, `^decide:.+$`; every subject LS-05 writes matches one), the check in `asRequestRecord` and `asAnswerData`, and `snapshotOf` as a typed view (no shape validation, design D5). Replace every `request.snapshot as XSnapshot` in the `complete-*.ts` files and `complete-validate.ts` with `snapshotOf(request)` narrowed on `kind`; a handler reached with another kind throws (routing is by the same subject, so this is unreachable). Add to Step 3: `"applying answers of every subject kind still complete"` in `tests/interaction/complete.test.ts` — one recorded `answer` comment per prefix (`gate:`, `amend:`, `question:`, `stuck:`, `decide:` with `digest` and `proposal`), each finished by `finishApplying` without throwing. Fix call sites the typecheck flags (build subjects with template literals; parse untrusted strings with `isSubject`).
- [ ] **Step 5: Failing test in `tests/interaction/complete.test.ts`** `"superseded reason is wrapped once"`: complete a gate request whose validation fails on a failing check message containing `<b>` (forge text) → `result` contains exactly one `<untrusted>` around that text (count occurrences of `<untrusted>` that enclose it, no `&lt;untrusted&gt;`).
- [ ] **Step 6: Implement:** `summary` in `complete.ts` uses `record.reason ?? "superseded"` unwrapped; in `complete-validate.ts`, `validateAmend` wraps `s.unit` and joined validator messages with `untrusted` where it builds the reason.
- [ ] **Step 7: Scenario tests:**
  - `"Amendment request kind"` in `tests/tools/unit-amend.test.ts`: forge chain, an edit → the `request` comment has `subject: "amend:1"`, `kind: "gate"`.
  - `"Decide request kind"` in `tests/tools/decide-ask.test.ts`: forge chain, test rule asks for `difficulty.U1` → `request` comment `subject: "decide:difficulty.U1"`, `kind: "stuck"`.
- [ ] **Step 8:** `bun run typecheck && bun run test` → PASS.
- [ ] **Step 9: Commit** in two commits: `refactor(approver-adapters): drop unused poll, confirm and gate digests` (Steps 1–2, after `bun run typecheck && bun run test tests/interaction tests/tools` passes) and `refactor(approver-adapters): type subjects and snapshots; wrap superseded reasons once` (Steps 3–7).

---

## Task 4: `/livespec class` applied once — implements 4

**Covers:** 4.1, 4.2, 4.3
**Difficulty:** Normal
**Blocked by:** Task 3

**Files:**
- Modify: `src/interaction/approver.ts`, `src/interaction/forge-match.ts`, `src/interaction/poll.ts`
- Test: `tests/interaction/poll.test.ts`, `tests/interaction/forge.test.ts`

**Interfaces:**
- Consumes: `Subject` from Task 3.
- Produces: `CLASS_KIND`, `MatchOptions.appliedClasses`, `ClassChange.commentId` (Contracts).

- [ ] **Step 1: Failing tests in `tests/interaction/poll.test.ts`** (a define change with a pending blocking `question:Q2` request posted by `postRequest`; `alice` has `write`):
  - `"Class command applied once"`: alice comments `/livespec class Q2 non-blocking`; `pollApprovals` → Q2 line `(non-blocking)` and one own `class` marker with id = alice's comment id and data `{ question: "Q2", class: "non-blocking" }`; edit Q2 back to `(blocking)` with `world.editBodyBehindBack`; refresh; `pollApprovals` → Q2 still `(blocking)`, still one `class` marker.
  - `"Class command already matching"`: Q2 already `(non-blocking)`; command `non-blocking`; poll → one `class` marker; edit to `(blocking)`; poll → stays `(blocking)`.
  - `"Class rewrite conflict retried"`: forge proxy whose first `updateIssueBody` call edits the body behind the back (as in `tests/tools/spec-question.test.ts` "answer later retries…"); poll → no `class` marker and the session records the conflict; poll again → Q2 `(non-blocking)` and one marker.
  - `"Class command recorded across sessions"`: after the first poll applied and recorded the command, edit Q2 back to `(blocking)`, build a new session on the same world (`toolHarness` with the same `MemoryWorld`, or `setSession` to a fresh session), poll → Q2 stays `(blocking)`.
  - `"class marker write failure applies the command once more"` (known gap, design D2): forge proxy whose first `createComment` of a `class` marker throws; poll → body `(non-blocking)`, no marker, session records the error; poll again → one marker, body still `(non-blocking)`.
  - `"class command for a closed question is skipped"`: Q2 answered (`[x]`) before the poll → no body write and no marker.
- [ ] **Step 2:** `bun run test tests/interaction/poll.test.ts` → the first three FAIL.
- [ ] **Step 3: Implement.**
  - `approver.ts`: `export const CLASS_KIND = "class"; registerKind(CLASS_KIND);`.
  - `forge-match.ts`: `ClassChange` carries `commentId`; in `apply`, skip a `class` command whose comment id is in `ctx.appliedClasses` (no warning).
  - `poll.ts`: `answerPending` builds `appliedClasses` from own `class` markers in `marked` and passes it. `applyClasses` keeps only open questions; computes the new body; if it changed, writes it — on `conflict`, records the retry message and returns without markers; then posts `writeMarked(CLASS_KIND, c.commentId, { question, class })` for each handled command (also when the body already matched).
- [ ] **Step 4:** `bun run test tests/interaction tests/tools/spec-question.test.ts` → PASS ("Human reclassifies" included).
- [ ] **Step 5: Commit** `fix(approver-adapters): apply a /livespec class command once`.

---

## Task 5: Spec-gap scenarios on existing behaviour — implements 5

**Covers:** 5.1, 5.2, 5.3
**Difficulty:** Normal
**Blocked by:** Task 3

**Files:**
- Test: `tests/tools/spec-question.test.ts`, `tests/tools/spec-gate.test.ts`, `tests/engine/next-step.test.ts`, `tests/tools/spec-stuck.test.ts`, `tests/interaction/complete.test.ts`
- Modify (only if a test shows divergence): the code it exercises

- [ ] **Step 1: Rename or add tests with the exact scenario names; each must pass against current code:**
  - `"Answer later in session"` (rename "answer later rewrites the question as non-blocking" in `spec-question.test.ts`; keep its assertions).
  - `"Named gate option recorded"` in `spec-gate.test.ts`: `registerGate("new-dependency", { checks: [], options: [{ id: "accept", label: "accept the dependency" }] })`, change in `build`, `ui: human("accept")` → gate data `{ gate: "new-dependency", choice: "accept", outcome: "approved", waivers: [] }`, not superseded; phase unchanged.
  - `"Named gate option does not waive"`: rename "in-session choice of a named gate option does not pass a failing waivable check"; add `expect(gate.outcome)` unchanged and `choose waive` text (already asserted).
  - `"Dirty tree when the answer is read"` in `spec-gate.test.ts`: forge chain, `spec_gate define` posts the request; write an untracked file (`writeIn(h.root, "scratch.txt", "x")`); alice comments `/livespec approve`; `pollApprovals(getSession())` → gate data `superseded: true`; the own `answer` marker has `verdict: "superseded"` and `reason` containing "working tree is dirty"; labels still `define`; `readRequests(marked)` has no pending or applying request.
  - `"Waived check does not hold the next step"`: rename "waived failing check does not block the advance" in `next-step.test.ts`.
  - `"Waived ship gate stays in ship"` in `spec-gate.test.ts`: register waivable `size-limits` for `ship` via a flow override like `SIZE_LIMITS_FLOW`; change in `ship`; `human("waive")` → gate `waivers: ["size-limits"]`, labels `["livespec:phase/ship"]`, `card(h).step.next` says ready to ship.
  - `"Dismissed stuck answer keeps the cap"`: rename "cap reached after a dismissed stuck answer asks for a new stuck report" in `spec-gate.test.ts`; add `expect(card(h).step.next).toContain("spec_stuck")`.
- [ ] **Step 2: Extend:** "Waive at the gate" already asserts `build` (keep). "Choice recorded" in `complete.test.ts`: add `outcome: "approved"` to the stuck answer assertion. "Stuck answer lifts the cap" in `spec-stuck.test.ts` already selects `B` with outcome `approved` (keep).
- [ ] **Step 3:** `bun run test` → PASS. If a test fails, fix the code to match the delta (design says none expected) and note it in the commit body.
- [ ] **Step 4: Commit** `test: pin LS-05 behaviour named by the #20 spec scenarios`.

---

## Task 6: Archived artifacts and docs — implements 6

**Covers:** 6.1, 6.2, 6.3, 6.4
**Difficulty:** Easy
**Blocked by:** Task 1, Task 2, Task 3, Task 4

**Files:**
- Modify: `openspec/changes/archive/2026-11-16-gates-and-decisions/design.md`, `…/plan.md`, `…/proposal.md`, `docs/architecture.md`

- [ ] **Step 1: `design.md`:** D3 first paragraph → "…at the start of every livespec tool, through the `registerLivespecTool` wrapper (`src/tools/register.ts`)."; D5 step 2 → "For approve, `ui.select` asks \"Add notes?\" (yes/no as labels, since `confirm` cannot tell no from cancel), then `ui.input`." and "Adjust Difficulty or Tags?" is a `select` too; "Escape or cancel" → "(`undefined`)"; D9 step 4 → `git merge --no-ff --no-edit origin/<integration>` (fast-forward is disabled when a merge is needed; an already up-to-date branch gets no new commit); D13 → "`requests`, `lock` (with `lock.gates`) and `iterations` (with `iterations.stuckOpen`)". Append `## Errata (#20)` listing these four fixes plus "Approver.poll and ApproverUI.confirm removed; GateSnapshot.digests and LockState.stalePhases removed".
- [ ] **Step 2: `plan.md` Contracts:** update rows `Subject`, `RequestRecord` (no `digests`; request kind per subject), `Approver` (no `poll`), `ApproverUI` (no `confirm`), `LockState` (no `stalePhases`), marker `stuck` answer data (`outcome`, `choice: ""` when dismissed), `interaction.adapter` (empty list counts as unset); add marker kind `class`; delete the "Spec contract note". Append `## Errata (#20)`.
- [ ] **Step 3: `proposal.md`:** `flow-engine` modified list gains **Loop counters** (`change_iterations` derived from own `stale` comments); "Known gaps" gains "two sessions or machines completing the same answer at once (polling is single-flight per session only)". Append `## Errata (#20)`.
- [ ] **Step 4: `docs/architecture.md`:** state that answers are collected by polling (no per-adapter `poll`), that a `/livespec class` command is recorded with a `class` marker and applied once, and that an empty `interaction.adapter` list falls through to the next layer.
- [ ] **Step 5:** `openspec validate --specs` and `bun run test` → PASS.
- [ ] **Step 6: Commit** `docs(openspec): correct archived LS-05 artifacts and architecture (#20)`.

---

## Scenario → test

- approver-adapters / Tool has no answer parameter → existing test of that name
- approver-adapters / Relayed approval refused → existing test of that name
- approver-adapters / Amendment request kind → `tests/tools/unit-amend.test.ts` (Task 3)
- approver-adapters / Decide request kind → `tests/tools/decide-ask.test.ts` (Task 3)
- approver-adapters / Approve in the TUI → existing
- approver-adapters / Unavailable without UI → existing
- approver-adapters / Answer later in session → `tests/tools/spec-question.test.ts` (Task 5, renamed)
- approver-adapters / Approve by a writer → existing
- approver-adapters / Command without write access ignored → existing
- approver-adapters / Command before the request ignored → existing
- approver-adapters / Answer that changes a requirement → existing
- approver-adapters / Class command applied once → `tests/interaction/poll.test.ts` (Task 4)
- approver-adapters / Class command recorded across sessions → `tests/interaction/poll.test.ts` (Task 4)
- approver-adapters / Class command already matching → `tests/interaction/poll.test.ts` (Task 4)
- approver-adapters / Class rewrite conflict retried → `tests/interaction/poll.test.ts` (Task 4)
- approver-adapters / Default chain → existing
- approver-adapters / No adapter available → existing
- approver-adapters / Project list with only unknown names → `tests/config.test.ts` (Task 2)
- approver-adapters / Empty project list → `tests/config.test.ts` (Task 2)
- approver-adapters / Every list empty → `tests/config.test.ts` (Task 2)
- phase-gates / Blocking question keeps the gate closed → existing
- phase-gates / Failing check that is not waivable → existing
- phase-gates / Self gate → existing
- phase-gates / Registered gate → existing
- phase-gates / Named gate option recorded → `tests/tools/spec-gate.test.ts` (Task 5)
- phase-gates / Named gate option does not waive → `tests/tools/spec-gate.test.ts` (Task 5, renamed)
- phase-gates / Waive at the gate → existing (`tests/tools/spec-gate.test.ts`)
- phase-gates / Waived ship gate stays in ship → `tests/tools/spec-gate.test.ts` (Task 5)
- phase-gates / Approve without waiving → existing
- phase-gates / Plan gate locks digests → existing
- phase-gates / HEAD moved before the answer → existing
- phase-gates / Forge approval completes → existing
- phase-gates / Issue edited before the answer → existing
- phase-gates / Dirty tree when the answer is read → `tests/tools/spec-gate.test.ts` (Task 5)
- flow-engine / No unit ready, Last phase, Blocking question first, Missing output, Not started, Next unit, Human gate ready, Pending gate request, Stuck report first, Frozen unit, Dismissed gate, Ship approved → existing tests of those names
- flow-engine / Waived check does not hold the next step → `tests/engine/next-step.test.ts` (Task 5, renamed)
- questions-and-stuck / Answer sends the change back, Cascade before the plan, Second answer while in define, Retried cascade counts once → existing
- questions-and-stuck / Cap reached → existing
- questions-and-stuck / Stuck answer lifts the cap → existing (`tests/tools/spec-stuck.test.ts`)
- questions-and-stuck / Dismissed stuck answer keeps the cap → `tests/tools/spec-gate.test.ts` (Task 5, renamed)
- questions-and-stuck / Stuck report waits for a choice, Option count enforced → existing
- questions-and-stuck / Choice recorded → existing (`tests/interaction/complete.test.ts`, extended in Task 5)
- unit-planning / Second plan gate re-locks, Plan gate with a stale unit → existing
- unit-planning / Stale before the first lock → `tests/engine/locks.test.ts` and `tests/e2e/gates-flow.test.ts` (Task 1)
- unit-planning / Identical amendment clears a stale unit → `tests/engine/locks.test.ts` (Task 1)
