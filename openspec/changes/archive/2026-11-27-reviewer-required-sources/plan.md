# Reviewer Required Sources Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Reviewer packets require only what the reviewer must judge; decision records and parent answers become one optional grouped source each; `finding-summary` keeps `notes`, `reason` and `evidence`.

**Architecture:** A `grouped` provider wrapper in `sources-records.ts` folds an existing record provider into one optional `records:<kind>` source, used only in the reviewer manifest. `render.ts` marks optional sources and `protocol.ts` explains them. `run-record.ts` copies the why fields into `finding-summary`; `interpret` already checks required sources only, and its BLOCKED reason already names the ids.

**Tech Stack:** TypeScript, Bun, Vitest (`bun run test`, `bun run typecheck`).

## Global Constraints

- Grouped ids are exactly `records:decisions` and `records:dispatch-answers`.
- A grouped source is `required: false`, `untrusted: true`, version = `sha256(text)`, and absent when it has no record.
- Implementer, verifier, scout, spec- and plan-review manifests are unchanged; implementer keeps per-answer `answer:<agentId>:<n>` required.
- `PROTOCOL_VERSION` becomes `2`.
- New `finding-summary` fields are optional; stored summaries without them stay valid.
- No new dependency; no change to `MISSING_SOURCE_RETURNS` or freshness.
- Code, comments, commits in English.

## Review Focus

- A grouped record's text contains human or child text → it must stay inside `<untrusted>`, never as state (Task 1 test "grouped records keep their ids").
- Two ANSWERED records for the same agent → ids inside the group stay `answer:<agentId>:1`, `:2` as `dispatchAnswers` numbers them today (Task 1 test asserts both ids).
- Optional source that spills → the spill list line still carries the optional mark (Task 2 test).
- `notes: ""` on a child result → no empty `notes` key is written to the summary (Task 3 test).
- Inline `subagent_record` for a reviewer omitting only optional sources → accepted, not refused (Task 4 step 2b, `tests/tools/subagent-record.test.ts`).

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| Source id form `records:<kind>` | new | `records:decisions` \| `records:dispatch-answers`; `PacketSource` with `required: false`, `untrusted: true`, `version: sha256(text)` | yes (packet text read by child agents) |
| `grouped` | new | `function grouped(kind: string, title: string, provider: Provider): Provider` in `src/subagents/sources-records.ts`; provider `name` is `` `records:${kind}` ``; returns `[]` when `provider` yields none, else one `placed({ id: \`records:${kind}\`, version: sha256(text), title, text, untrusted: true, required: false })`; `text` = each inner source as `#### <inner id>\n<inner text>` joined by `\n\n`, in provider order; each body line starting with `#` is escaped as `\#`, so record text cannot forge a heading (final review Important 1) | no |
| `renderSource` output | modified | after `version: <v>` line, an optional source adds the line `optional: list in sources_used only if you used it`; required sources unchanged | yes (packet text) |
| Spilled sources list line | modified | `- <id> <version> <path>` gains suffix ` (optional)` for an optional source | yes (packet text) |
| `PROTOCOL_VERSION` | modified | `1` → `2` | yes |
| Protocol Result paragraph | modified | `List by id in \`sources_used\` every required source. A source marked optional is listed only if you used it. Record in \`discoveries\` anything a later unit needs to know.` (opening "Submit your result once through `submit_result`." unchanged) | yes |
| Return-to-child message | modified | `Your result omits required sources from sources_used: <ids>. Read them, then submit your result again listing every required source.` | no |
| `FindingSummaryData` | modified | adds `notes?: string; evidence?: string`; `reason?: string` now set for every role | yes (forge marker format) |
| `isSummaryData` | modified | also accepts `optional(d.notes, isStr)` and `optional(d.evidence, isStr)` | no |

---

## Task 1: Optional grouped record sources in reviewer packets — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/subagents/sources-records.ts` (add `grouped`)
- Modify: `src/subagents/sources.ts:32` (`REVIEWER_ALL`)
- Test: `tests/subagents/sources.test.ts`

**Interfaces:**
- Consumes: `decisionRecords`, `dispatchAnswers(all)`, `placed`, `sha256`, `Provider` (existing).
- Produces: `grouped` and the two `records:*` ids (see Contracts).

- [ ] **Step 1: Write failing tests** in `tests/subagents/sources.test.ts`, `describe("grouped records")`:
  - `"records do not grow the required list"`: one world (each `makeWorld()` has its own repo SHAs, so the `diff:` id differs across worlds). Collect `reviewer`/`change` sources with no records (A); then post 30 `decision` comments (`world.post(BOT, writeMarked("decision", \`decision.d${i}\`, { note: i }))`) and 15 `ANSWERED` dispatch comments with distinct `agentId`s (`dispatchComment({ status: "ANSWERED", role: "implementer", unit: "U3", agentId: \`agent-${i}\`, answer: "a" })`) into the same world and collect again (B). Required ids of A `toEqual` required ids of B; B ids contain `records:decisions` and `records:dispatch-answers` with `required: false`; A contains neither; B contains no `comment:<decision id>` and no `answer:agent-*` id.
  - `"grouped records keep their ids"`: one decision comment with data `{ answer: "push now" }`; reviewer `unit` U3 packet text section `### records:decisions` contains `comment:<id>` and matches `/<untrusted>[^]*push now[^]*<\/untrusted>/`; `ids(...)` does not contain `comment:<id>`.
  - `"two answers to one child keep their numbers"`: two ANSWERED records for `agent-1`; `records:dispatch-answers` text contains `answer:agent-1:1` and `answer:agent-1:2`.
  - `"implementer answers stay required"`: one ANSWERED record `{ role: "implementer", unit: "U3", agentId: "agent-1" }`; U3 implementer sources contain `answer:agent-1:1` with `required: true` and no `records:dispatch-answers`.
  - `"a new record changes the grouped version, not the required ids"`: build reviewer `change` packet, add one decision, build again; `records:decisions` version differs, `packet.hash` differs, required ids equal.
- [ ] **Step 2: Update** the existing test `"text a child or a human wrote is untrusted in the dependent packet"`: its loop splits on `### comment:${id}`; give each loop entry its own section heading, `### records:decisions` for the review packet, and additionally assert that section contains `#### comment:<decision id>`.
- [ ] **Step 3: Run** `bun run test tests/subagents/sources.test.ts` → the new tests FAIL (no `records:*` source).
- [ ] **Step 4: Implement** `grouped` per Contracts in `src/subagents/sources-records.ts`; in `REVIEWER_ALL` replace `dispatchAnswers(true)` with `grouped("dispatch-answers", "Answers the parent gave to children", dispatchAnswers(true))` and `decisionRecords` with `grouped("decisions", "Decision records", decisionRecords)`, keeping their positions. Inner sources are already untrusted; render inner text raw inside the group (the group is wrapped once by `renderSource`).
- [ ] **Step 5: Run** `bun run typecheck && bun run test` → PASS; fix any other test that expected a per-record reviewer id.
- [ ] **Step 6: Commit** `feat(subagents): group decision records and dispatch answers into optional reviewer sources`

---

## Task 2: Optional marking in the packet and protocol — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4
**Difficulty:** Easy
**Blocked by:** Task 1

**Files:**
- Modify: `src/subagents/render.ts` (`renderSource`, spilled list in `renderTask`)
- Modify: `src/subagents/protocol.ts`
- Modify: `src/subagents/dispatch.ts:200` (`returnToChild` message)
- Test: `tests/subagents/packet.test.ts`, `tests/subagents/protocol.test.ts`

**Interfaces:**
- Consumes: `records:*` optional sources from Task 1.
- Produces: optional marking text, protocol v2 (see Contracts).

- [ ] **Step 1: Write failing tests**:
  - `packet.test.ts` `"optional source marked inline"`: world with one decision record; reviewer `unit` U3 packet; the `### records:decisions` section contains `optional: list in sources_used only if you used it`; the `### file:specs/constraints.md` section does not.
  - `packet.test.ts` `"optional source marked when spilled"`: reviewer `unit` U3 packet (the `build()` helper takes `"unit"`); seed ~20 decision records with 1500-char data and set the budget from a baseline packet with no records (`Math.ceil(baseline.text.length / 4) + 500`), so `records:decisions` must spill and the rest fits; the `### Spilled sources` list line for `records:decisions` ends with ` (optional)`; no required spilled line has it.
  - `protocol.test.ts` `"explains optional sources"`: `protocolText()` contains `every required source` and `optional`; `PROTOCOL_VERSION` is `2`.
- [ ] **Step 2: Run** `bun run test tests/subagents/packet.test.ts tests/subagents/protocol.test.ts` → FAIL.
- [ ] **Step 3: Implement** the Contracts texts in `render.ts`, `protocol.ts` and the `returnToChild` message in `dispatch.ts`.
- [ ] **Step 4: Run** `bun run test` → PASS (e2e `"omits required sources"` assertions still match).
- [ ] **Step 5: Commit** `feat(subagents): mark optional sources in packets and protocol v2`

---

## Task 3: Finding summary keeps the why — implements 3

**Covers:** 3.1, 3.2, 3.3
**Difficulty:** Easy
**Blocked by:** none

**Files:**
- Modify: `src/subagents/records.ts` (`FindingSummaryData`)
- Modify: `src/subagents/validate.ts` (`isSummaryData`)
- Modify: `src/subagents/run-record.ts` (`summaryData`, `verifierFields`)
- Test: `tests/subagents/records.test.ts`, `tests/subagents/dispatch.test.ts`

**Interfaces:**
- Produces: `FindingSummaryData.notes`, `.evidence`, `.reason` for all roles (see Contracts).

- [ ] **Step 1: Write failing tests**:
  - Reviewer results must match the reviewer schema (`additionalProperties: false`, no `commits`): add a local helper `const review = (over = {}) => JSON.parse(JSON.stringify({ ...done(over), commits: undefined, findings: [] }))`, as `dispatch.test.ts:356` does.
  - `dispatch.test.ts` `describe("runDispatch")` `"why of a run kept"`: reviewer request (`role: "reviewer", subject: "unit"`, default packet with required `answer:Q2`) and child result `review({ status: "DONE_WITH_CONCERNS", sources_used: ["answer:Q2"], notes: "checked the retry path" })` → posted `finding-summary` data has `notes: "checked the retry path"`. Second run: `review({ status: "BLOCKED", sources_used: ["answer:Q2"], reason: "no diff", evidence: "empty range" })` → data has that `reason` and `evidence`.
  - `dispatch.test.ts` `"parent-written block names omitted ids"`: reviewer request, two records `review({ sources_used: [] })` (fake executor resumes once) → posted `finding-summary` has `status: "BLOCKED"`, `reason` and `notes` contain `answer:Q2`, `evidence: "recorded by the parent"`.
  - `dispatch.test.ts` `"empty notes are not recorded"`: `review({ sources_used: ["answer:Q2"], notes: "" })` → posted data has no `notes` key.
  - `records.test.ts` `"older summary still valid"`: `isSummaryData` of a summary without `notes`/`reason`/`evidence` is `true`; with `notes: 1` is `false`.
- [ ] **Step 2: Run** `bun run test tests/subagents/dispatch.test.ts tests/subagents/records.test.ts` → FAIL.
- [ ] **Step 3: Implement**: add the optional fields to `FindingSummaryData`; `isSummaryData` validates `notes` and `evidence` as optional strings; a small `whyFields(result)` helper in `run-record.ts` returns `notes`, `reason`, `evidence` via `optional(key, value || undefined)` (`optional()` skips only `undefined`), spread into `summaryData` for every role; `verifierFields` keeps `verifies` and `verdict` only (its `reason` now comes from `summaryData`).
- [ ] **Step 4: Run** `bun run typecheck && bun run test` → PASS; update any exact-equality summary assertion elsewhere that now sees the new fields.
- [ ] **Step 5: Commit** `feat(review): record notes, reason and evidence in finding summaries`

---

## Task 4: Result handling and #268-shaped review fixture — implements 4

**Covers:** 4.1, 4.2, 4.3
**Difficulty:** Normal
**Blocked by:** Task 1, Task 2, Task 3

**Files:**
- Test: `tests/subagents/dispatch.test.ts`, `tests/tools/subagent-dispatch.test.ts`, `tests/tools/subagent-record.test.ts`
- Modify: `docs/architecture.md` (packet sources section near line 240, `finding-summary` bullet at line 271)

**Interfaces:**
- Consumes: Tasks 1–3 behaviour.

- [ ] **Step 1: Write tests** in `tests/subagents/dispatch.test.ts` `describe("result interpretation")`:
  - `"missing optional source accepted without return"`: `interpret(rec({ ...withSources(["answer:Q2"]), commits: undefined, findings: [] }), packet(), "reviewer", h0)` (the default packet has optional `spec:x`; reviewer schema rejects `commits`) → `kind: "accept"`.
  - `"blocked reason names omitted required ids"`: `interpret(rec(done()), packet(), "implementer", { ...h0, returns: 1 })` → `{ kind: "blocked", reason: expect.stringContaining("answer:Q2") }` and reason does not contain `spec:x`.
- [ ] **Step 2: Write the #268 fixture test** in `tests/tools/subagent-dispatch.test.ts`, `"review round 1 with many records does not block"`: `subagentHarness({ executor: {} })`; seed 29 `decision` records (`h.seed("decision", \`tags.d${i}\`, { tags: ["x"] })`) and 14 `ANSWERED` dispatch records with distinct `agentId`s (`h.seed("dispatch", \`dispatch.change.reviewer.answered.${i}\`, { status: "ANSWERED", role: "reviewer", agentId: \`agent-old-${i}\`, answer: "stop this dispatch" })`; confirm the seeded ids are distinct and the records are read by `dispatchAnswers`). Child returns `DONE` with `findings: []`, `commits: undefined` and `sources_used` = `footerIds(prompt)` filtered to drop `records:` ids. Call `subagent_dispatch { role: "reviewer", subject: "change" }` (persona `agents/code-reviewer.md` is present via `makeTree`; if the dispatch is refused for a missing role skill, add it to the tree as `tests/e2e/review-flow.test.ts:34` does). Assert: the spawned prompt's footer contains `records:decisions` and `records:dispatch-answers`; `h.fake.resumed` is empty; latest `finding-summary` has `status: "DONE"`, `completed: true`, `round: 1`; its `required` holds no `records:` id, no `comment:` id of a seeded decision and no `answer:agent-old-` id. Before Task 1 this test fails on the footer and `required` assertions, so it guards the regression.
- [ ] **Step 2b: Write test** in `tests/tools/subagent-record.test.ts`, `"a reviewer recording without optional sources is accepted"`: seed one decision record; `subagent_packet` for `reviewer` `unit` U1; `subagent_record` with a reviewer result whose `sources_used` is the footer ids minus `records:` ids → not an error, and the latest `finding-summary` has `completed: true`.
- [ ] **Step 3: Run** `bun run test tests/subagents/dispatch.test.ts tests/tools/subagent-dispatch.test.ts` → PASS (behaviour from Tasks 1–3). If the fixture fails, fix the cause in the owning source file, not the test.
- [ ] **Step 4: Update** `docs/architecture.md`: reviewer packet holds `records:decisions` and `records:dispatch-answers` as optional grouped sources, optional sources are marked and never returned or blocked; `finding-summary` also holds `notes`, `reason` and `evidence`.
- [ ] **Step 5: Run** `bun run typecheck && bun run test` → both pass, report counts.
- [ ] **Step 6: Commit** `test(subagents): pin reviewer optional sources and #268 review round`

---

## Scenario → test

- Packet layers / Stable prefix → `tests/subagents/packet.test.ts` "stable prefix" (existing)
- Packet layers / Prohibitions present → `packet.test.ts` "prohibitions present" (existing)
- Packet layers / Optional source marked → `packet.test.ts` "optional source marked inline" + "optional source marked when spilled" (Task 2)
- Protocol content / Flow-neutral protocol → `protocol.test.ts` "protocol names no default-pack skill" (existing)
- Protocol content / Optional sources explained → `protocol.test.ts` "explains optional sources" (Task 2)
- Context manifest / Answered question included → `sources.test.ts` "answered question included" (existing)
- Context manifest / Spec review sees the diff → `sources.test.ts` "spec review sees the diff" (existing)
- Context manifest / Diff as a file → `sources.test.ts` "diff as a file" (existing)
- Context manifest / Persona file → `sources.test.ts` `describe("Persona file")` (existing)
- Context manifest / Verifier of an in-change finding → existing verifier source test in `sources.test.ts`
- Context manifest / Glossary entries for the unit → existing glossary test (`tests/docs/readers.test.ts`, `tests/docs/glossary-terms.test.ts`)
- Context manifest / Spine and capability decisions → existing decisions reader test (`tests/docs/readers.test.ts`)
- Context manifest / Reviewer sees constraints → `sources.test.ts` "Reviewer sees constraints" (existing)
- Context manifest / Records do not grow the required list → `sources.test.ts` "records do not grow the required list" (Task 1)
- Context manifest / Grouped records keep their ids → `sources.test.ts` "grouped records keep their ids" (Task 1)
- Context manifest / Implementer answers stay required → `sources.test.ts` "implementer answers stay required" (Task 1)
- Source ids and versions / Same inputs, same hash → `packet.test.ts` "same inputs same hash" (existing)
- Source ids and versions / Comment edited → `packet.test.ts` "comment edited changes hash" (existing)
- Source ids and versions / New record changes the grouped version → `sources.test.ts` "a new record changes the grouped version, not the required ids" (Task 1)
- Return contract / Blocked without evidence → `dispatch.test.ts` "blocked without evidence treated as missing" (existing)
- Return contract / Verifier without a verdict → `tests/tools/subagent-dispatch.test.ts` "Verifier without a verdict is retried, with one it is recorded" (existing)
- Return contract / Scout verdicts accepted → existing scout schema test in `tests/subagents/roles.test.ts`
- Return contract / Core sources only → `tests/tools/subagent-dispatch.test.ts` "review round 1 with many records does not block" (Task 4)
- Result handling / Missing required source → `dispatch.test.ts` "missing required source returned once then BLOCKED" (existing)
- Result handling / Missing optional source → `dispatch.test.ts` "missing optional source accepted without return" (Task 4)
- Result handling / Blocked reason names the omitted ids → `dispatch.test.ts` "blocked reason names omitted required ids" (Task 4) + "parent-written block names omitted ids" (Task 3)
- Result handling / Needs context capped → `dispatch.test.ts` "needs context capped at 2" (existing)
- Result handling / Crash retried once → `dispatch.test.ts` "a crash is retried once, then blocked" (existing)
- Result handling / Missing prerequisite opens the dependency gate → existing missing-prerequisite tests in `tests/subagents/dispatch.test.ts` and `tests/e2e/initiative-flow.test.ts`
- Result handling / Missing prerequisite past the cap → existing cap tests in `tests/tools/subagent-dispatch.test.ts` and `tests/tools/new-dependency.test.ts`
- Result handling / Review round with many records does not block → `tests/tools/subagent-dispatch.test.ts` "review round 1 with many records does not block" (Task 4)
- Finding summary comment / Unit review recorded → `dispatch.test.ts` "a unit review posts one finding-summary holding both findings" (existing)
- Finding summary comment / Why of a run kept → `dispatch.test.ts` "why of a run kept" (Task 3)
- Finding summary comment / Parent-written block names omitted ids → `dispatch.test.ts` "parent-written block names omitted ids" (Task 3)
- Finding summary comment / Older summary still valid → `records.test.ts` "older summary still valid" (Task 3)
