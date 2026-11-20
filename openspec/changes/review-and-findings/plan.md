# Review fan-out and finding routing Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Build the `review` phase: one re-entrant `spec_review` tool that fans out independent reviewers, aggregates and verifies their findings, and routes each finding by its location, with a round cap and a self gate that passes only on a clean, current review.

**Architecture:** Pure modules in `src/review/` (route, standards, aggregate, status, round planner, selection) carry every decision; `src/tools/spec-review.ts` wires them to the forge, git, the `Verify` runner and the existing `runDispatch`. All state is derived from own marked comments (`review-run`, aggregate `finding-summary`, verifier `finding-summary`, `rebuild`), so each stage is skipped once its record exists for HEAD.

**Tech Stack:** TypeScript (Bun, `tsc --noEmit`), vitest, `yaml`; existing livespec seams (`registerRule`, `registerCheck`, `registerGatePayload`, `registerKind`, `runDispatch`).

## Global Constraints

- No new dependency; no model named anywhere (ADR 0005); livespec ships no agent files.
- Every forge write is an own marked comment or an existing tool effect; tools refuse in a child session.
- Repository text (code, comments, user-facing strings, commits) in English.
- Verify commands always pass through the command guard before they run; output is redacted as `runVerify` already does.
- Follow `~/.agents/skills/coding-standards/SKILL.md`: one responsibility per file, pure functions for decisions, no god function in the tool.

## Review Focus

1. **A finding path with `./`, a leading `/`, Windows separators or no line** (`src/a.ts`, `./src/a.ts:3`, `src\a.ts:3`). Expect normalization, line `1` when missing, and the same route and dedup key. Pinned in Task 1 (`normalizeLocation` tests) and Task 6 (dedup test).
2. **A rename in the diff.** A finding at the old path of a renamed file must stay `in-change`, not `out-of-scope`. Pinned in Task 1 (`diffNameStatus` rename test plus a route test).
3. **The tool call is cancelled mid fan-out.** Every spawned child must be aborted and nothing recorded for them. Pinned in Task 7 (`fanout` cancel test).
4. **The verifier refutes a parent or `missed-context` finding through `subagent_record` by hand.** The refutation must not make the finding `DISPUTED`, because those findings never need verification. Pinned in Task 6 (status test).
5. **A second `spec_review` call while nothing changed after a routed round.** It must post nothing, and the next step must be the gate or `unit_amend`. Pinned in Task 7 (idempotence test).

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `routeFinding` | new | `(finding: Finding, facts: RouteFacts) => { route: Route; unit?: string }` in `src/review/route.ts` | yes (LS-09) |
| `Route` | new | `"unit" \| "in-change" \| "out-of-scope" \| "question" \| "record"` | yes |
| `RouteFacts` | new | `{ path: string; units: { id: string; files: string[] }[]; diffFiles: string[]; needsDecision: boolean }` (kind and severity come from the finding) | yes |
| `normalizeLocation` | new | `(location: string) => { path: string; line: number }` in `src/review/route.ts`; strips `./` and a leading `/`, turns `\\` into `/`, keeps the line of `path:line` or `path:line:col`, line 1 when absent | yes |
| `decisions.finding-scope` | new | pack config `{ mode: rule }`; rule registered as point `finding-scope`, never asks | yes (pack key) |
| `Git.diffNameStatus` | new | `(from: string, to: string) => Promise<{ status: string; path: string; oldPath?: string }[]>`, from `git diff --name-status -z -M <from>..<to>` (NUL-separated, so quoted paths parse) | no |
| `diffFilesOf` | new | `(entries: Awaited<ReturnType<Git["diffNameStatus"]>>) => string[]`: every `path` and `oldPath`, deduplicated | no |
| `checkStandards` | new | `(diff: string, opts: { constraintsCited: boolean }) => Finding[]` in `src/review/standards.ts`; every finding `CRITICAL`, `lowered-standard`, scope `unit` | no |
| `SubagentResult.verdict` | modified | adds `verdict?: "confirmed" \| "refuted"`; required in the `verifier` result schema | no |
| `subagent_dispatch` / `subagent_packet` / `subagent_record` param `finding` | modified | optional string `<aggregateCommentId>:<index>`; required for `verifier`, refused for other roles | yes (tool API) |
| `FindingSummaryData` | modified | adds `verifies?: string; verdict?: "confirmed" \| "refuted"; reason?: string; aggregate?: true; reviews?: string[]`; `findings` of an aggregate are `AggregateFinding[]` | no |
| `RunFacts.finding` / `DispatchRequest.finding` | modified | adds `finding?: string` (the verified key), copied into `verifies` | no |
| `aggregateFinding` | new | `(marked: MarkedComment[], key: string) => { commentId: string; index: number; finding: AggregateFinding } \| undefined` in `src/subagents/records.ts`; the only reader of one aggregate finding | no |
| `AggregateFinding` | new | `Finding & { from: string[]; needsDecision: boolean; route: Route; routeUnit?: string; verify: "required" \| "skipped-missed-context" \| "skipped-parent" \| "skipped-suggestion" \| "skipped-off" }` | no |
| `review-run` marker | new | kind `review-run`, id `review-run.<round>`, data `{ round: number; head: string; selected: ReviewSubject[]; tags: string[]; verify: Record<string, { exit: number \| null; verdict: "green" \| "red" \| "invalid" }>; parentFindings: Finding[]; routed: boolean; prComments?: string[] }` | no |
| `rebuild` marker | new | kind `rebuild`, id `rebuild.<unit>.<round>`, data `{ unit: string; round: number; finding: string }` | no |
| aggregate `finding-summary` id | new | `finding-summary.change.review.<round>` | no |
| verifier `finding-summary` id | new | `finding-summary.verify.<token(key)>.<attempt>` | no |
| `decision` `finding-scope.review-<round>` | new | outcome `Record<string, { route: Route; unit?: string }>` keyed by aggregate index | no |
| `decision` `tags.review` | new | outcome `string[]` (tags no unit carries), source `rule`, no digest | no |
| `review-clean` check | new | gate-only check of the `review` phase, registered in `registerBuiltinChecks` | yes (pack check name) |
| `CheckGit.head` | modified | adds `head(): Promise<string>` to `CheckGit` in `src/engine/registry.ts` | no |
| `Caps.reviewRounds` | modified | `Caps` in `src/engine/snapshot.ts` adds `reviewRounds: number \| undefined`; `deriveCommentFacts` reports `counters.review_rounds` | no |
| `Decision` | modified | the next-step `Decision` type moves from `next-step.ts` to `state-types.ts` and is exported | no |
| `spec_review` tool | new | params `{}`; result text names the stage run, launched or inline runs, and the next step | yes (tool API) |
| `StartData.pre.verdict` | modified | adds `"rebuild"` | no |
| `UnitEvidence.rebuilds` | new | optional `rebuilds?: Record<string, { round: number; finding: string }>` in `src/evidence/unit-state.ts`: units whose latest `rebuild` is newer than their latest receipt and `unit-start` (optional so existing test literals stay valid) | no |
| default pack `review` phase | modified | adds `checks: [review-clean]` and the `subagents` list of design D9; `decisions.finding-scope: { mode: rule }` | yes (pack) |

---

## Task 1: Routing core — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/review/route.ts`, `tests/review/route.test.ts`
- Modify: `src/decide/registry.ts`, `src/engine/git.ts`, `tests/engine/git.test.ts`, `tests/decide/registry.test.ts`

**Interfaces:**
- Produces: `routeFinding`, `normalizeLocation`, `Route`, `RouteFacts`, `Git.diffNameStatus`, `diffFilesOf` (Contracts).

- [ ] **Step 1: Write failing route tests** in `tests/review/route.test.ts`:
  - "Seeded defect routed to its unit": `routeFinding({ severity: "WARNING", kind: "defect", location: "src/limit.ts:10", scope: "out-of-scope", … }, { path: "src/limit.ts", units: [{ id: "U1", files: ["src/a.ts"] }, { id: "U2", files: ["src/limit.ts"] }], diffFiles: ["src/limit.ts"], needsDecision: false })` returns `{ route: "unit", unit: "U2" }`.
  - "Changed file outside every unit" returns `in-change`. "Untouched file" returns `out-of-scope`. "Suggestion" returns `record`.
  - "Missed context outside the diff": a `SUGGESTION` `missed-context` finding at a file outside the diff returns `in-change`.
  - "Deleted test file stays in the change": the path appears in `diffFiles` only, and the result is `in-change`.
  - `needsDecision: true` returns `question`.
  - A glob in `Files` (`src/**/*.ts`) matches.
  - The first unit in body order wins.
  - `normalizeLocation("./src\\a.ts")` returns `{ path: "src/a.ts", line: 1 }`; `normalizeLocation("/src/a.ts:3:7")` returns `{ path: "src/a.ts", line: 3 }`. A finding at the old path of a renamed file routes `in-change`.
- [ ] **Step 2:** Run `bunx vitest run tests/review/route.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `src/review/route.ts`, using `matchGlob` from `src/core/glob.ts`. The order is that of design D5.
- [ ] **Step 4: Register the rule.** In `registerBuiltinRules` (`src/decide/registry.ts`), call `registerRule("finding-scope", findingScopeSchema, findingScopeRule)`, both exported from `src/review/route.ts`. `findingScopeSchema.validate` uses `checkAllowedKeys(node, ["mode"], …)` as `progressSchema` (`src/evidence/progress-rule.ts`) does; `findingScopeRule(facts)` takes `{ finding, ...RouteFacts }` and returns `{ outcome: routeFinding(...), reason }` naming the matched rule. Add tests:
  - `decide("finding-scope", facts, { config: { mode: "rule" }, subject: "review-1" })` returns `source: "rule"`;
  - pack validation accepts `decisions.finding-scope: { mode: rule }`.
- [ ] **Step 5: Add `diffNameStatus`.** Put it in `createGit` (`src/engine/git.ts`) as `git diff --name-status -z -M <from>..<to>`. Parse the NUL-separated fields; `R<score>` is followed by old then new, giving `{ status: "R", path: new, oldPath: old }`. Add `diffFilesOf`. Test it in `tests/engine/git.test.ts` with a temp repo: one modified file, one deleted file and one renamed file, so `diffFilesOf` returns all four paths.
- [ ] **Step 6:** Run `bunx vitest run tests/review tests/engine/git.test.ts tests/decide`. Expected: PASS.
- [ ] **Step 7:** Commit with `feat(review): routeFinding and finding-scope rule`.

---

## Task 2: `constraints-not-weakened` — implements 2

**Covers:** 2.1, 2.2
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/review/standards.ts`, `tests/review/standards.test.ts`
- Modify: none (uses `isTestFile` from `src/evidence/pending.ts`).

**Interfaces:**
- Consumes: `isTestFile` (`src/evidence/pending.ts`). `parseGitDiff` reads only file headers, so `standards.ts` walks hunks itself.
- Produces: `checkStandards` (Contracts).

- [ ] **Step 1: Write the failing tests**, one per rule of design D11. Each feeds a unified diff string and asserts the exact `location`:
  - "Added skip": `+  it.skip("limits", () => {` in hunk `@@ -10,0 +12,1 @@` of `test/limit.test.ts` gives `test/limit.test.ts:12`.
  - `xit(`, `describe.only(`, `xdescribe(` are each flagged.
  - `@ts-ignore` is flagged. `// @ts-expect-error` is flagged, and so is `// @ts-expect-error:` with no text after the colon. "Expect-error with a reason" (`// @ts-expect-error: the vendor type is wrong`) is not flagged.
  - `/* eslint-disable */` and `// eslint-disable-next-line no-console` are flagged.
  - "Deleted test file" gives `test/old.test.ts:1`.
  - Removed assertions:
    - three `-  expect(` lines and one `+  expect(` line in `test/a.test.ts` give one finding at the old line of the first removed one;
    - an equal count gives no finding;
    - removed `expect(` lines in `src/a.ts`, which is not a test file, give no finding.
  - With `constraintsCited: true`, the evidence contains `specs/constraints.md`.
- [ ] **Step 2:** Run `bunx vitest run tests/review/standards.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `checkStandards(diff, opts)`. Walk the files and hunks, track the new and old line numbers from the `@@` headers, and apply the regexes of design D11.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit with `feat(review): constraints-not-weakened check`.

---

## Task 3: Verifier role contract — implements 3

**Covers:** 3.1, 3.2, 3.3, 3.4, 3.5
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Modify:
  - `src/subagents/roles.ts`, `validate.ts`, `result.ts`, `records.ts`, `run-record.ts`, `dispatch.ts` (`runFacts`), `sources-git.ts`, `sources-records.ts`, `payload.ts`, `source-types.ts`;
  - `src/tools/subagent-target.ts`, `subagent-dispatch.ts`, `subagent-packet.ts`, `subagent-record.ts`, `subagent-request.ts`.
- Test: `tests/subagents/roles.test.ts`, `records.test.ts`, `sources.test.ts`; `tests/tools/subagent-dispatch.test.ts`, `subagent-record.test.ts`.

**Interfaces:**
- Produces:
  - `SubagentResult.verdict`, the `finding` tool parameter, and the `FindingSummaryData` additions (Contracts);
  - `aggregateFinding` (Contracts): it finds the `finding-summary` whose `commentId` is the key's prefix, with `aggregate: true`, and returns `findings[index]`. Task 6 reuses it and defines no second reader.
- Consumes: none.

- [ ] **Step 1: Write the failing tests.**
  - Verifier result schema: a result without `verdict` is invalid (`subagent-dispatch` "Verifier without a verdict").
  - Refusals:
    - "Verifier without a finding";
    - a `finding` given for `implementer` is refused;
    - a key that names no aggregate is refused.
  - "Verifier recorded": `subagent_record verifier` with `finding: "c1:0"`, verdict `refuted` and reason `guarded by caller` posts `finding-summary.verify.c1-0.1` with `role: verifier`, `verifies: "c1:0"`, `verdict: "refuted"`, `reason: "guarded by caller"`.
  - "Verifier of an in-change finding": the packet builds and holds the finding and the code. No `owning-unit` error is raised.
  - Readers ignore verifier and aggregate records:
    - `unresolvedBlocking(marked, "U1", …)` ignores a verifier summary whose findings name U1's file;
    - `unitFindings` does not include them;
    - `changeReviewDoneAt(marked, "change", head)` is false for an aggregate only;
    - `nextRound(marked, "reviewer", undefined, "change")` does not count the aggregate.
- [ ] **Step 2:** Run the listed test files. Expected: FAIL.
- [ ] **Step 3: Implement the schema change.** In `roles.ts`, `resultSchema("verifier")` adds `verdict` to `properties` and `required`. `validate.ts` checks it.
- [ ] **Step 4: Implement the target parameter.** `subagent-target.ts` parses and validates `finding`. `subagent-request.ts` resolves it with `aggregateFinding` into `PacketContext.finding` and refuses with the spec texts.
- [ ] **Step 5: Fix `owningUnit`.** In `sources-git.ts`, return `[]` when no unit owns the path.
- [ ] **Step 6: Record verifier runs.** `DispatchRequest` and `RunFacts` carry `finding`; `runFacts` in `dispatch.ts` copies it. In `run-record.ts`, `summaryData` adds `verifies`, `verdict` and `reason` for `verifier`; `isSummaryData` accepts them. In `records.ts`, `findingSummaryComment` uses id `finding-summary.verify.<token(verifies)>.<attempt>` for a verifier. `isSystem`, `summariesOf` and the readers exclude `role === "verifier"` and `aggregate === true`.
- [ ] **Step 7:** Run `bunx vitest run tests/subagents tests/tools`. Expected: PASS, with no regressions.
- [ ] **Step 8:** Commit with `feat(subagents): verifier takes a finding and returns a verdict`.

---

## Task 4: Persona packets and review pack entries — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4, 4.5
**Difficulty:** Normal
**Blocked by:** Task 3

**Files:**
- Create: `src/subagents/sources-persona.ts`.
- Modify: `src/subagents/sources.ts`, `policy.ts`, `phase-entries.ts`; `src/packs/agent-skills.yaml`; `tests/fixtures/agent-skills.pack.json`.
- Test: `tests/subagents/sources.test.ts`, `policy.test.ts`, `card.test.ts` (phase entries); `tests/engine/pack-load.test.ts`.

**Interfaces:**
- Produces:
  - the `personaFile` provider. Its source id is `file:agents/<name>.md` and it reads `<activeTree>/agents/<name>.md`; `change` maps to `code-reviewer`. A missing file throws `persona file agents/<name>.md is missing from the content tree`.
  - `reviewEntriesRunBySpecReview(phaseId: string): boolean`, true for `review`. It is exported from `phase-entries.ts` and used by Task 8.

- [ ] **Step 1: Write the failing tests.**
  - "Persona file" for `persona:security-auditor`. A `change` packet lists `file:agents/code-reviewer.md`. A missing persona file refuses and names the file.
  - A round-1 reviewer packet holds no source for another reviewer's `finding-summary` of the round. Assert that the source ids hold no `comment:` id of a reviewer summary.
  - "Review entries" (subagent-policy): `personas()` returns the four names.
  - "Default pack contents" deep-equals the updated fixture with the `review` `subagents` entries.
  - "No one-by-one suggestion in review": `phaseEntryStep(pack, state, reviewPhase)` is `undefined`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement the provider** in `src/subagents/sources-persona.ts` and add it to the reviewer manifest for subjects `change` and `persona:*` in `sources.ts`. No reviewer provider reads `finding-summary` today, so the "no other reviewer's output" test only pins that; change no other provider.
- [ ] **Step 4: Report the persona.** `personas()` adds `code-reviewer` when an entry has `subject: change`.
- [ ] **Step 5: Update the pack.** In the YAML, add the `subagents` list of design D9 to `review`; update the fixture. `checks: [review-clean]` and `decisions.finding-scope` are added by Task 6, after their registrations exist (`pack-schema.ts` rejects unregistered checks, and `validateDecisions` unregistered points).
- [ ] **Step 6:** `phaseEntryStep` returns `undefined` when `reviewEntriesRunBySpecReview(phase.id)`.
- [ ] **Step 7:** Run `bunx vitest run tests/subagents tests/engine`. Expected: PASS.
- [ ] **Step 8:** Commit with `feat(review): persona packets and review pack entries`.

---

## Task 5: Rebuild marker — implements 5

**Covers:** 5.1, 5.2, 5.3
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Modify:
  - `src/evidence/unit-state.ts` (`UnitEvidence.rebuilds`), `records.ts` (`rebuildComment`, `isStartPre` accepts verdict `rebuild`), `refusals.ts`;
  - `src/tools/unit-start.ts`, `unit-finish.ts`;
  - `src/engine/next-step.ts` (`nextUnit` names `unit_start` for a rebuild).
- Test: `tests/evidence/unit-state.test.ts`, `tests/tools/unit-start.test.ts`, `unit-finish.test.ts`, `tests/engine/next-step.test.ts`.

**Interfaces:**
- Produces:
  - `rebuildComment(data: { unit: string; round: number; finding: string }): string`, in `src/evidence/records.ts`, with kind `rebuild` registered;
  - `UnitEvidence.rebuilds`.

- [ ] **Step 1: Write the failing tests.**
  - "Rebuild starts green": U2 has a receipt for its digest, then `rebuild.U2.1`, a pending line and a green `Verify`. `unit_start U2` posts `unit-start` with `pre.verdict: "rebuild"`.
  - "Rebuild is not re-ticked": `deriveUnitEvidence` does not list U2 in `untickedReceipts`. `unit_finish U2` refuses with text naming `unit_start U2`. In `build`, `nextStep` names `unit_start U2`.
  - A rebuild with a red `Verify` still starts with verdict `red`.
  - After `unit-start` and a new receipt, U2 is no longer a rebuild.
  - After a rebuild start with verdict `rebuild`, a green post run posts a receipt and ticks U2 (the post run does not require a red pre).
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Track rebuilds in `unit-state.ts`.** In the comment pass, track the latest `rebuild` index per unit. `untickedReceipts` excludes a unit whose latest rebuild is newer than its latest receipt. `rebuilds` lists units whose latest rebuild is newer than both the latest receipt and the latest `unit-start`.
- [ ] **Step 4: Accept a green rebuild.** In `unit-start.ts` `preRun`: when the unit is in `state.evidence.rebuilds` and the class is `green`, accept it with verdict `rebuild`. Otherwise keep the existing expectation.
- [ ] **Step 5: Name `unit_start` for a rebuild.** `unitFinishRefusal` already refuses a unit that is not started; make its text for a rebuild name `unit_start <unit>`. In `next-step.ts` `nextUnit`, a ready unit in `rebuilds` reads `Rebuild U2 — <title>: run unit_start U2.`
- [ ] **Step 6:** Run `bunx vitest run tests/evidence tests/tools/unit-start.test.ts tests/tools/unit-finish.test.ts tests/engine/next-step.test.ts`. Expected: PASS.
- [ ] **Step 7:** Commit with `feat(evidence): rebuild marker for review-routed units`.

---

## Task 6: Review records, aggregation and status — implements 6

**Covers:** 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
**Difficulty:** Hard
**Blocked by:** Task 1, Task 3, Task 4

**Files:**
- Create: `src/review/records.ts`, `aggregate.ts`, `status.ts`; `tests/review/records.test.ts`, `aggregate.test.ts`, `status.test.ts`.
- Modify: `src/engine/counters.ts`, `src/engine/snapshot.ts` (`Caps.reviewRounds`, `SnapshotDeps.caps.reviewRounds`, `deriveCommentFacts`), the callers that build `caps` (`src/hooks/card-input.ts`, `src/interaction/complete-validate.ts`), `src/engine/registry.ts` (`CheckGit.head`), `src/engine/checks.ts` (`registerBuiltinChecks` registers `review-clean`; the check context's git gets `head`), `src/subagents/sources-records.ts` (`unitFindings` includes routed aggregate findings), `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json` (`review` `checks: [review-clean]`, `decisions.finding-scope`); `tests/engine/counters.test.ts`, `snapshot.test.ts`, `checks.test.ts`, `pack-load.test.ts`, `tests/subagents/sources.test.ts`, and the fakes that build `CheckGit`.

**Interfaces:**
- Consumes: `routeFinding`, `normalizeLocation` (Task 1); verifier record shape and `aggregateFinding` (Task 3).
- Produces:
  - `reviewRunComment(data: ReviewRunData): string`;
  - `aggregateComment(data: { round: number; head: string; reviews: string[]; findings: AggregateFinding[] }): string`;
  - `latestRun(marked): ReviewRunData & { commentId: string } | undefined`;
  - `runAtHead(marked, head): ReviewRunData | undefined`;
  - `aggregateOf(marked, round): { commentId: string; data: FindingSummaryData } | undefined` (whole record; single findings come from `aggregateFinding`);
  - `verifierRecord(marked, key): FindingSummaryData | undefined`;
  - `mergeFindings(input: { parent: Finding[]; reviews: { commentId: string; findings: Finding[] }[] }): MergedFinding[]` where `MergedFinding = Finding & { from: string[]; needsDecision: boolean }`;
  - `withRoutes(merged: MergedFinding[], routes: { route: Route; unit?: string }[], verifierOff: boolean): AggregateFinding[]`;
  - `findingState(marked, aggregateCommentId, index, questions): "disputed" | "rebutted" | "answered" | "unverified" | "blocking" | "open"`;
  - `blockingFindings(marked, aggregateCommentId, questions): { index: number; finding: AggregateFinding }[]`;
  - `reviewRounds(marked, cap): { value: number; blocking: boolean }`;
  - `registerReviewClean(): void`.

- [ ] **Step 1: Write the failing tests.**
  - Aggregate: "Two reviewers, one defect" gives one `CRITICAL` with both keys; with `verifierOff` every blocking finding gets `skipped-off`. "Same file, other line" gives two findings. The `needs-decision` mark is kept. A parent finding gets `verify: "skipped-parent"`, a `missed-context` finding `skipped-missed-context`, and a `SUGGESTION` `skipped-suggestion`.
  - Status:
    - "Refuted finding" is `disputed`. "Confirmed finding" and "Verifier blocked" are `blocking`.
    - "Unverified finding blocks". "Answered question" no longer blocks.
    - `out-of-scope` and `record` never block. A rebutted `WARNING` does not block, but a rebutted `missed-context` still blocks.
    - Review Focus 4: a `refuted` verifier record for a parent finding does not make it `disputed`.
  - Cap: "Cap reached", "Stuck answer restarts the budget" and "Last round finishes before the cap" (the cap does not block until the round is `routed`). A round whose only blocker is a `question` finding does not count toward blocking. A stuck answer not sent while the cap blocked does not reset the count.
  - Counters: "Derived review rounds" ignores a `counter` comment of 9 and reports 2 of 3 (the value counts every aggregate; only blocking looks at findings).
  - Sources: "Unit unticked" (packet half): U2's implementer packet lists the aggregate finding routed to U2.
  - `review-clean` fails when the latest aggregate's head differs from HEAD ("Code changed after review"). It passes for "Clean round passes the gate".
- [ ] **Step 2:** Run `bunx vitest run tests/review tests/engine/counters.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the records and aggregation.** Write `records.ts` (`registerKind("review-run")`), then `aggregate.ts` (dedup key `${path}:${line}:${kind}`, severity rank `CRITICAL > WARNING > SUGGESTION`), then `status.ts`.
- [ ] **Step 4: Derive the counter.** In `counters.ts`, add `review_rounds` to `DERIVED_COUNTERS`. In `snapshot.ts`, `Caps` gains `reviewRounds` (from `loops.review_rounds`, wired where `iterations` is) and `deriveCommentFacts` adds `review_rounds: reviewRounds(marked, caps.reviewRounds).value` to `counters`. `unitFindings` adds every aggregate finding whose `routeUnit` is the unit.
- [ ] **Step 5:** Add `head()` to `CheckGit` and to the check context built in `checks.ts`. Register `review-clean` inside `registerBuiltinChecks` with `registerCheck("review-clean", fn, { at: "gate" })`. `src/review/records.ts` calls `registerKind("review-run")` at module load. Add `checks: [review-clean]` to `review` and `finding-scope: { mode: rule }` to `decisions` in the pack and fixture; extend "Spot check" for them. `fn` returns one error result naming the reason (no round at HEAD, or the blocking findings) or `[]`.
- [ ] **Step 6:** Run the tests. Expected: PASS.
- [ ] **Step 7:** Commit with `feat(review): aggregate records, finding status and round cap`.

---

## Task 7: `spec_review` — implements 7

**Covers:** 7.1, 7.2, 7.3, 7.4, 7.5
**Difficulty:** Very Hard
**Blocked by:** Task 2, Task 4, Task 5, Task 6

**Files:**
- Create:
  - `src/review/select.ts`, `retag.ts`, `fanout.ts`, `round.ts`, `start.ts`, `effects.ts`, `stages.ts`;
  - `src/tools/spec-review.ts`.
- Modify: `src/tools/register.ts`, `src/subagents/phase-entries.ts` (export `changeFacts`).
- Test:
  - `tests/review/select.test.ts`, `retag.test.ts`, `fanout.test.ts`, `round.test.ts`, `effects.test.ts`;
  - `tests/tools/spec-review.test.ts`, which reuses `tests/subagents/fake-executor.ts` and `tests/tools/subagent-helpers.ts`.

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5, 6 as listed in the Contracts; `runDispatch`, `dispatchRequest` and `packetContext` (`src/tools/subagent-request.ts`); `runVerify` and `verifyEnv`; `runSpecQuestion(params, ctx)` (`src/tools/spec-question.ts`); `untickUnit` (`src/core/tick.ts`).
- Produces:
  - `selectSubjects(pack, state, extraTags): ReviewSubject[]`;
  - `retag(pack, state, diffFiles): string[]`;
  - `fanOut(runs: (() => Promise<DispatchOutcome>)[], signal?): Promise<PromiseSettledResult<DispatchOutcome>[]>`;
  - `nextStage(state, pack): { stage: "start" | "review" | "aggregate" | "verify" | "route" | "done" | "refused"; missing?: ReviewSubject[] | string[]; reason?: string }`;
  - `startInputs(ctx): Promise<{ verify: ReviewRunData["verify"]; parent: Finding[]; diffFiles: string[]; tags: string[] } | { refused: string }>` and `unitVerifyFindings(runs: { unit: Unit; run: VerifyRun }[]): Finding[]` in `start.ts` (red or invalid → `CRITICAL` `defect` at `<Files[0]>:1`, output tail as evidence);
  - `applyRoutes(deps, state, aggregate): Promise<{ posted: string[]; rejected: string[] }>`;
  - `runStage(stage, ctx): Promise<StageReport>` in `stages.ts`, where `StageReport = { text: string; inline?: string[]; stop: boolean }`;
  - the `spec_review` tool.

- [ ] **Step 1: Write the failing selection tests.** Cover "Security tag from the plan", "Three units" and "Auth file without a security tag" (`retag` returns `["security"]` for `src/auth/session.ts`, and selection then adds `persona:security-auditor`). `context>=N%` never holds.
- [ ] **Step 2: Write the failing fan-out tests.** In "Parallel reviewers", the fake executor records `spawn` order. Both spawns happen before the first `wait` resolves. When the signal is cancelled, `abort` is called for both children and no `post` happens. Extend `tests/subagents/fake-executor.ts` with a deferred `wait` if it cannot hold runs open yet.
- [ ] **Step 3: Write the failing planner tests.** One test per stage transition of design D2. Cover:
  - "Resumed after an interruption";
  - "New HEAD restarts the round";
  - the refusals of review-phase "Review tool", including "Unit not done";
  - the cap: no `start` while it blocks, but `verify` and `route` still run;
  - a `BLOCKED` reviewer is not relaunched until a newer lifting stuck answer;
  - every other `runDispatch` outcome of a reviewer or verifier: `question` stops the call and names `subagent_answer`; `inline` and `sequential` return the inline packet arguments for that run; `stuck` stops and names `spec_stuck`; `cancelled` records nothing.
- [ ] **Step 4: Write the failing effects tests.**
  - "Unit unticked": the rebuild comment is posted before the body untick, and both are idempotent.
  - "Question raised once".
  - "No pull request".
  - "Retried stage", where the existing review comment carries the marker `<!-- livespec:finding c9:0 -->`.
  - A forge rejection is reported in `rejected`.
- [ ] **Step 5: Write the failing tool tests** in `tests/tools/spec-review.test.ts`, covering the issue's "Done when" list end to end with the fake executor and forge:
  - a seeded defect in `src/limit.ts`, where U2 lists the file, ends with `rebuild.U2.1` and U2 unticked;
  - a finding refuted by the fake verifier is `DISPUTED`, and `spec_gate review` passes;
  - an `out-of-scope` finding does not block;
  - three routed rounds with a `unit` finding make the next step `spec_stuck`;
  - an auth file without a `security` tag launches `persona:security-auditor`;
  - an added `.skip` yields a `CRITICAL` `lowered-standard` aggregate finding without a verifier launch.

  Also cover:
  - every refusal of review-phase "Review tool": child session, wrong phase, unit not done, "No Base" (and a failing `git diff`), dirty tree, open blocking question, unanswered stuck report, pending blocking request, cap blocking a start, guard-blocked `Verify`;
  - the route stage's `spec_question` is non-blocking, so the same call goes on to post `routed: true`;
  - "Round started";
  - "Red unit at review";
  - "Inline without an executor": the result names `subagent_packet reviewer change` and `subagent_record reviewer change`;
  - "Reviewer packet has no other reviewer's output";
  - Review Focus 5: a second call after a routed round posts nothing.
- [ ] **Step 6:** Run `bunx vitest run tests/review tests/tools/spec-review.test.ts`. Expected: FAIL.
- [ ] **Step 7: Implement the pure modules.** Export `changeFacts` from `phase-entries.ts`; `select.ts` calls it and adds the re-checked tags, with `turnsCompleted: 0`. Then write `retag.ts`, which calls `decide("tags", …)` with the diff files, `fanout.ts`, `round.ts` and `start.ts`.
- [ ] **Step 8: Implement `effects.ts`.** Post the rebuild comment, then untick through a version-checked body write as `complete-question.ts` does. Raise questions through `runSpecQuestion({ text, class: "non-blocking" }, ctx)` with the session's `ApproverCtx`. Post PR comments with `createReviewComment`, after `listReviewComments` for marker de-duplication.
- [ ] **Step 9: Implement `stages.ts` and `spec-review.ts`.**
  - `stages.ts`, one function per stage:
    - start: `startInputs(ctx)` in `start.ts` gathers, in order, every unit's `Verify` (body order, through `env.run.guard` and `runVerify`) with `unitVerifyFindings`, the diff files, `retag`, and `checkStandards` on `git.diff(base, "HEAD", ".")` with `constraintsCited` true when `specs/constraints.md` exists; the stage then posts `tags.review`, runs `selectSubjects` and posts the `review-run`;
    - review and verify: `fanOut` of `runDispatch` per missing run, mapping each outcome as Step 3 lists;
    - aggregate: `mergeFindings`, one `decide("finding-scope")` per merged finding, the `finding-scope.review-<n>` decision record, `withRoutes`, then the aggregate post;
    - route: `applyRoutes`, then a new `review-run` comment with the same id and `routed: true`.
  - `spec-review.ts` loops: load state → `nextStage` → `runStage` → `afterForgeWrite` and reload state, until a report has `stop` or the stage is `done`/`refused`. It refuses in a child session, as `subagent_dispatch` does. Register it in `register.ts`.
- [ ] **Step 10:** Run `bunx vitest run tests/review tests/tools`. Expected: PASS.
- [ ] **Step 11:** Commit with `feat(review): spec_review fans out, aggregates, verifies and routes`.

---

## Task 8: Next steps, ship payload and simplify — implements 8

**Covers:** 8.1, 8.2, 8.3, 8.4
**Difficulty:** Normal
**Blocked by:** Task 7

**Files:**
- Create: `src/review/next.ts` (review next-step rules), `src/review/payload.ts` (ship payload).
- Modify: `src/engine/next-step.ts`, `src/engine/state-types.ts` (export `Decision`), `src/review/payload.ts` exports `registerReviewPayload()`, called from `registerBuiltinChecks` in `src/engine/checks.ts` (which runs at module load) so tests that reset gates call it again, `src/subagents/payload.ts` (aggregate `out-of-scope` follow-ups with keys), `src/tools/unit-amend.ts`.
- Test: `tests/engine/next-step.test.ts`, `tests/engine/gate-payload.test.ts`, `tests/tools/unit-amend.test.ts`, `tests/review/next.test.ts`, `tests/review/payload.test.ts`.

**Interfaces:**
- Consumes: `nextStage`, `reviewRounds`, `blockingFindings` and `latestRun` (Tasks 6 and 7); skill notes from `state` (`src/hooks/skill-reads.ts`).
- Produces: `reviewStep(pack, state): Decision | undefined`, inserted as rule 14 before the gate; `Decision` is imported from `state-types.ts` to avoid a cycle.

- [ ] **Step 1: Write the failing tests.**
  - `review-phase`: "Back to build" (`advance: "build"`), "In-change finding", "Reviewer blocked", "Cap reached" (`spec_stuck` before the return to build), "Simplify offered".
  - `flow-engine`: "Review round before the gate".
  - `finding-routing`: "Disputed and inline at ship" and "Rebutted aggregate finding", in the payload.
  - `unit-planning`: "Simplify as a feature" is refused, and "Simplify as a refactor" sends a request.
  - "Out of scope does not block": the ship payload lists the follow-up.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement `src/review/next.ts`.** Follow the order of design D8 and call it from `next-step.ts` only when the phase id is `review`.
- [ ] **Step 4: Register the ship payload.** `registerReviewPayload()` calls `registerGatePayload("ship", reviewPayload)` with the lines of finding-routing "Review result at the ship gate". Wrap untrusted text with `untrusted()`. In `subagentFindingsSection`, add the latest routed aggregate's non-`DISPUTED` `out-of-scope` findings with keys `<aggregateCommentId>:<index>`, so every human gate lists them until one has shown them.
- [ ] **Step 5: Refuse a non-refactor `simplify`.** In `unit-amend.ts`, refuse when a new or replacement unit's title, trimmed and lower-cased, is `simplify` and its `kind !== "refactor"`. The text is `a simplify unit must be Kind: refactor`.
- [ ] **Step 6:** Run `bunx vitest run tests/engine tests/review tests/tools/unit-amend.test.ts`. Expected: PASS.
- [ ] **Step 7:** Commit with `feat(review): review next steps, ship payload and simplify unit`.

---

## Task 9: Docs and end-to-end — implements 9

**Covers:** 9.1, 9.2, 9.3
**Difficulty:** Normal
**Blocked by:** Task 8

**Files:**
- Create: `tests/e2e/review-flow.test.ts`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Write the e2e test.** Model it on `tests/e2e/subagent-build.test.ts`. A two-unit change reaches `review`. `spec_review` with the fake executor works as follows:
  - the `change` reviewer reports a defect in U2's file and a finding the fake verifier refutes;
  - the change returns to `build`, and U2 is rebuilt (green start, verdict `rebuild`, receipt, tick);
  - round 2 is clean;
  - `spec_gate review` writes an approved gate with `head_sha` equal to round 2's head, and the change moves to `ship`.
- [ ] **Step 2:** Run `bunx vitest run tests/e2e/review-flow.test.ts`. Expected: PASS. If it fails, fix the owning task's module, not the test.
- [ ] **Step 3: Update `docs/architecture.md`.** Add a `## Review` section after `## Subagents` covering:
  - stages and records;
  - selection and personas;
  - `constraints-not-weakened`;
  - the verifier and `DISPUTED`;
  - routing and `routeFinding`;
  - the rebuild marker;
  - the cap;
  - the gate.

  Replace the sentence "The `verifier` role is reserved for LS-08 …" with one stating that it takes a finding reference.
- [ ] **Step 4:** Run `bun run typecheck && bun run test`. Expected: both pass with no failures.
- [ ] **Step 5:** Commit with `docs(review): architecture review section and e2e review flow`.

---

## Scenario → test

**review-phase**
- Round started → `tests/tools/spec-review.test.ts` "round started"
- Resumed after an interruption → `tests/review/round.test.ts` "resumed after an interruption"
- Unit not done → `tests/review/round.test.ts` "unit not done"
- No Base → `tests/tools/spec-review.test.ts` "no Base"
- New HEAD restarts the round → `tests/review/round.test.ts` "new HEAD restarts the round"
- Red unit at review → `tests/tools/spec-review.test.ts` "red unit at review"
- Parallel reviewers → `tests/review/fanout.test.ts` "parallel reviewers"
- Inline without an executor → `tests/tools/spec-review.test.ts` "inline without an executor"
- Reviewer packet has no other reviewer's output → `tests/subagents/sources.test.ts` "reviewer packet has no other reviewer's output"
- Security tag from the plan → `tests/review/select.test.ts`
- Three units → `tests/review/select.test.ts`
- Auth file without a security tag → `tests/review/retag.test.ts` and `tests/tools/spec-review.test.ts` "security persona from the diff"
- Added skip → `tests/review/standards.test.ts` and `tests/tools/spec-review.test.ts` "added skip"
- Expect-error with a reason → `tests/review/standards.test.ts`
- Deleted test file → `tests/review/standards.test.ts`
- Cap reached → `tests/review/status.test.ts` and `tests/review/next.test.ts`
- Stuck answer restarts the budget → `tests/review/status.test.ts`
- Last round finishes before the cap → `tests/review/status.test.ts` and `tests/review/round.test.ts`
- Clean round passes the gate → `tests/review/status.test.ts` "review-clean passes"
- Code changed after review → `tests/review/status.test.ts` "review-clean fails on new HEAD"
- Back to build → `tests/review/next.test.ts`
- Reviewer blocked → `tests/review/next.test.ts`
- In-change finding → `tests/review/next.test.ts`
- Simplify offered → `tests/review/next.test.ts`

**finding-routing**
- Two reviewers, one defect → `tests/review/aggregate.test.ts`
- Same file, other line → `tests/review/aggregate.test.ts`
- Reviewer still missing → `tests/review/round.test.ts`
- Refuted finding → `tests/review/status.test.ts`
- Confirmed finding → `tests/review/status.test.ts`
- Missed context skips the verifier → `tests/review/aggregate.test.ts`
- Verifier blocked → `tests/review/status.test.ts`
- Seeded defect routed to its unit → `tests/review/route.test.ts`
- Changed file outside every unit → `tests/review/route.test.ts`
- Untouched file → `tests/review/route.test.ts`
- Deleted test file stays in the change → `tests/review/route.test.ts`
- Missed context outside the diff → `tests/review/route.test.ts`
- Suggestion → `tests/review/route.test.ts`
- Unit unticked → `tests/review/effects.test.ts` and `tests/tools/unit-finish.test.ts` (next step `unit_start`)
- Question raised once → `tests/review/effects.test.ts`
- Out of scope does not block → `tests/tools/spec-review.test.ts` and `tests/engine/gate-payload.test.ts`
- Unverified finding blocks → `tests/review/status.test.ts`
- Answered question → `tests/review/status.test.ts`
- No pull request → `tests/review/effects.test.ts`
- Retried stage → `tests/review/effects.test.ts`
- Disputed and inline at ship → `tests/engine/gate-payload.test.ts`
- Rebutted aggregate finding → `tests/review/status.test.ts` and `tests/engine/gate-payload.test.ts`

**review-findings**
- Needs a decision → existing `tests/subagents/records.test.ts` (unchanged)
- Out of scope does not block the tick → existing `tests/tools/unit-finish-findings.test.ts` (unchanged)
- Reviewer scope ignored in an aggregate → `tests/review/aggregate.test.ts`
- Disputed finding → `tests/review/status.test.ts` and `tests/review/payload.test.ts` (not listed as a follow-up)

**subagent-dispatch**
- Unit role without a unit, Called in a child → existing `tests/tools/subagent-dispatch.test.ts`
- Verifier without a finding → `tests/tools/subagent-dispatch.test.ts`
- Verifier recorded → `tests/tools/subagent-record.test.ts`
- Blocked without evidence → existing `tests/subagents/dispatch.test.ts`
- Verifier without a verdict → `tests/subagents/roles.test.ts`

**subagent-packets**
- Answered question included, Spec review sees the diff, Diff as a file → existing `tests/subagents/sources.test.ts`
- Persona file → `tests/subagents/sources.test.ts`
- Verifier of an in-change finding → `tests/subagents/sources.test.ts`

**subagent-policy**
- Build entries → existing `tests/subagents/policy.test.ts`
- Review entries → `tests/subagents/policy.test.ts`
- No one-by-one suggestion in review → `tests/subagents/card.test.ts`

**flow-pack**
- Default pack loads, Default pack contents, Spot check → `tests/engine/pack-load.test.ts`, with the fixture updated

**flow-engine**
- No unit ready, Last phase, Blocking question first, Missing output, Not started, Next unit, Human gate ready, Pending gate request, Stuck report first, Frozen unit, Dismissed gate, Ship approved, Blocked unit asks for a stuck report, Started unit before the next unit, Waived check does not hold the next step → existing `tests/engine/next-step.test.ts` (unchanged)
- Review round before the gate → `tests/engine/next-step.test.ts`
- Counter shown with cap → `tests/engine/counters.test.ts`, changed to `discovered_deps`
- Counter update edits in place, Derived iteration count, Derived unit attempts → existing `tests/engine/counters.test.ts`
- Derived review rounds → `tests/engine/counters.test.ts`

**unit-evidence**
- Red at pre starts the unit, Green at pre is refused, Refactor unit must pass at pre, Dirty tree, Frozen unit, Unmet dependency, One started unit at a time, Started in a lane, Restart after an amendment → existing `tests/tools/unit-start.test.ts` (unchanged)
- Green at post, Not green at post, Not started, Open lane refuses finish, Crash between receipt and tick, Digest changed since start, Unresolved blocking finding, Review required but not run, Lane review accepted after merge, Incomplete review does not count, Receipted unit with a new blocking finding → existing `tests/tools/unit-finish.test.ts` and `tests/tools/unit-finish-findings.test.ts` (unchanged)
- Rebuild starts green → `tests/tools/unit-start.test.ts`
- Rebuild is not re-ticked → `tests/evidence/unit-state.test.ts` and `tests/tools/unit-finish.test.ts`

**unit-planning**
- Simplify as a feature, Simplify as a refactor → `tests/tools/unit-amend.test.ts`

---

## Contract deviations (recorded during apply)

- `retag` (internal): calls the registered `tags` rule through `ruleFor("tags")` synchronously instead of the async `decide()`, keeping the planned sync signature; the rule never asks. The start stage posts `tags.review` itself.
- `startInputs` (internal): takes `{ state, pack, env }` instead of the tool context; refuses a guard-blocked `Verify` before running any unit.
- `nextStage` (internal): also refuses while a child question is open (`subagent_answer`); a pending unit refuses only `start`/`review`, a round already aggregated always finishes `verify`/`route`.
- `EffectDeps` (internal): `{ forge, issue, branch, ask, afterWrite }`; `ask` wraps `runSpecQuestion({ text, class: "non-blocking" }, ctx)`.
- `StageReport` (internal): adds optional `error` so the tool can return `isError`; `runStage` takes the `NextStage` object (it needs `missing`).
- `summariesOf` (internal, Task 3): keeps verifier and aggregate records; unit readers exclude them through `isDerived`, because `aggregateFinding` reads through it.
