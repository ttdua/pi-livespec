## Context

- **What exists (LS-07).** Role dispatch (`subagent_dispatch`, `subagent_packet`, `subagent_record`, `subagent_answer`) with packets, the `finding-summary` record, `finding_rebut`, the build loop with unit reviews, phase-level advisory reviewer suggestions (`phase-entries.ts`), and a reserved `verifier` role whose packet refuses because no tool passes it a finding (`sources-git.ts` `findingAndCode`).
- **The executor.** `spawn` returns an agent id at once and `wait(id)` is a separate promise, so several children can run at the same time with the current service (`src/subagents/executor.ts`). `runDispatch` (`dispatch.ts`) handles one child end to end: watch, spawn, post-launch check, wait, interpret, record.
- **The `review` phase** in `src/packs/agent-skills.yaml` has `gate: self`, `skills.required: [code-review-and-quality]`, optional `code-simplification`, and no `subagents` entries. `build` has no gate and advances to `review` once every unit is done; `planMove` already allows moving back to an earlier phase.
- **Personas.** The managed agent-skills tree holds `agents/code-reviewer.md`, `security-auditor.md`, `test-engineer.md` and `web-performance-auditor.md`. `content/compat.ts` already fails when a referenced persona file is missing.
- **Records.** `records.ts` derives everything from own marked comments. `unresolvedBlocking` reads unit summaries; `answeredFindingKeys` links a `needs-decision` question to its finding through `finding:<commentId>:<index>` in the question text; `gatesShownKeys` lists findings a gate payload showed.
- **Forge.** `listPullRequests({ state, head })`, `listReviewComments(pr)` and `createReviewComment(pr, { path, line, body })` exist on both adapters.

## Goals / Non-Goals

**Goals:**
- One re-entrant tool, `spec_review`, runs a review round whose every stage is derived from forge records, so an interrupted, inline or partly dispatched round resumes without repeating finished work.
- Aggregation, verification and routing are code, not agent discretion.
- `routeFinding` is a pure function LS-09 can call on pull request comments and CI failures.

**Non-Goals:**
- LS-09's routing of pull request comments and CI failures, the small-fix lane, and follow-up issues.
- Changing how advisory define/plan reviews and unit reviews launch: they already use `context: "fresh"` and their own packets, which satisfies the independence rules.

## Decisions

### D1. Module layout: `src/review/`, one responsibility per file

| File | Responsibility |
|---|---|
| `round.ts` | The round's state machine as a pure function: from the change state, which stage is next (`start`, `review`, `aggregate`, `verify`, `route`, `done`). |
| `start.ts` | The start stage's inputs: every unit's `Verify` at HEAD and the parent findings of red or invalid runs. |
| `stages.ts` | One function per stage (start, review, aggregate, verify, route), each doing its writes and returning what the tool reports. |
| `select.ts` | Reviewer selection: evaluates the `review` phase's `reviewer` entries against change facts whose tags include the re-checked tags. Pure. |
| `retag.ts` | Runs the `tags` rule over the files of `git diff <Base>..HEAD` and returns tags no unit carries. |
| `standards.ts` | The `constraints-not-weakened` check over a unified diff with hunk line numbers. Pure. |
| `aggregate.ts` | De-duplication of reviewer findings and parent findings into aggregate findings. Pure. |
| `route.ts` | `routeFinding(finding, facts)` and the `finding-scope` rule registration. Pure. |
| `status.ts` | Derived status of each aggregate finding (verification verdict, rebuttal, question answered) and whether it blocks; the `review-clean` check. Pure. |
| `records.ts` | The `review-run` marker kind, the aggregate `finding-summary` shape, verifier record shape and their queries. |
| `effects.ts` | Idempotent route effects: untick units, raise questions, post pull request comments. |
| `fanout.ts` | Runs several `runDispatch` calls concurrently with `Promise.allSettled`, sharing the tool call's abort signal. |

The tool lives in `src/tools/spec-review.ts` and only wires these together: it loops `nextStage` → stage function → re-read state, so every stage reads the comment ids the previous one posted. The re-read is `afterForgeWrite` followed by the same state load `prepareWrite` does. `runDispatch` is reused unchanged per child; parallelism is only in `fanout.ts`.

### D2. The round as stages derived from records

A round number `n` is the count of aggregate records plus one. Its stages, each skipped when its record already exists for the current HEAD:

1. **start.** Refuse unless the change is in `review`, every unit is done, the tree is clean, no blocking question, stuck report or blocking request is open, and the round cap does not block. Run every unit's `Verify` at HEAD through the guard. Re-check tags. Run `constraints-not-weakened`. Select reviewers. Post one `review-run` record (id `review-run.<n>`) with `head`, `selected` subjects, `tags` (re-checked), `verify` (unit → exit and verdict), and `parentFindings`. A red or invalid `Verify` adds a parent finding `CRITICAL defect` at `<first File of the unit>:1` with the output tail as evidence; reviewers are still launched so one round finds everything.
2. **review.** For each selected subject without a completed reviewer `finding-summary` at this HEAD, dispatch (fan-out). With no capable executor, return each missing subject's `subagent_packet`/`subagent_record` arguments and stop; the parent reviews inline, one at a time, then calls `spec_review` again.
3. **aggregate.** Post the aggregate `finding-summary` (D3).
4. **verify.** For each aggregate finding that needs verification and has no verifier record, dispatch the `verifier` (fan-out), or return the inline instructions.
5. **route.** Apply route effects (D6), then post a new `review-run` comment with the same id and `routed: true` (the latest comment of an id wins, as for every marker), so no version-checked edit is needed. It runs only when every finding needing verification has a completed or a `BLOCKED` verifier record.

A new HEAD starts a new `review-run` with the same `n` (latest record of the id wins), so an abandoned round never counts. A reviewer that ends without a completed result follows the existing result handling (`subagent-dispatch` "Result handling"). A run that ends `BLOCKED` is not relaunched; the next step is `spec_stuck` naming the subject. Any other incomplete run is dispatched again by the next call.

Why one re-entrant tool over a single long call: inline review must hand control back to the parent between reviewers, and a crash must not repeat launches; deriving stages from records gives both.

### D3. Aggregate record and de-duplication

The aggregate is a `finding-summary` with id `finding-summary.change.review.<n>`, `role: reviewer`, `subject: change`, `aggregate: true`, `round: n`, `head`, `completed: true`, `reviews` (comment ids of the reviewer summaries) and `findings`. Each aggregate finding holds the six schema fields plus `from` (the `<commentId>:<index>` keys it merged, or `parent`), `route`, `routeUnit` (for `unit`) and `verify` (`required`, `skipped-missed-context`, `skipped-parent`, `skipped-suggestion`, `skipped-off`).

De-duplication key: `(path, line, kind)` after normalising the location (no `./` or leading `/`, forward slashes; `path:line:col` keeps the line; no line means line 1). `aggregate.ts` exposes `mergeFindings` (dedup, pure) and `withRoutes` (attach routes, pure); the aggregate stage calls `decide("finding-scope")` for each merged finding between them, so the decision record and the aggregate's routes come from the same calls. Merged findings keep the highest severity, the first evidence and fix, every source key, and `needs-decision` if any source marked it. Findings at the same path and kind on different lines stay separate.

The aggregate is excluded from `changeReviewDoneAt`, `unresolvedBlocking` of units and `nextRound` of reviewers by its `aggregate: true` flag; the review phase reads it through `src/review/records.ts`.

### D4. Verifier contract

- `subagent_dispatch`, `subagent_packet` and `subagent_record` accept `finding: "<aggregateCommentId>:<index>"` for role `verifier`, and refuse it for other roles. A verifier without it, or with a key that names no aggregate finding, is refused.
- The packet context gets that finding, so `findingAndCode` and `owningUnit` work. `owningUnit` no longer refuses when no unit owns the file; it then adds nothing, because an `in-change` finding has no owner.
- The verifier result schema adds required `verdict` (`confirmed` or `refuted`) with `reason`. It is recorded as a `finding-summary` with `role: verifier`, `verifies: <key>`, `verdict`, and id `finding-summary.verify.<token(key)>.<attempt>`.
- A finding is `DISPUTED` when its latest completed verifier record says `refuted`. A verifier that ends `BLOCKED` counts as confirming (fail closed); any other incomplete run is dispatched again by the next call. The `findings` field of a verifier result is ignored, and every reader of unit or change findings (`unresolvedBlocking`, `unitFindings`, payloads) skips `role: verifier` records.
- A `verifier` entry with `mode: off` in the pack disables verification: findings get `verify: "skipped-off"` and blocking findings stay blocking.
- The verifier's `reason` (from its result) is stored in its `finding-summary` so the ship payload can show why a finding was refuted.

### D5. `finding-scope` rule and `routeFinding`

`routeFinding(finding, facts)` with `facts = { path, units: { id, files }[], diffFiles, needsDecision, severity }` returns `{ route, unit? }`:
1. `SUGGESTION` not of kind `missed-context` → `record`;
2. `needsDecision` → `question`;
3. path matches a unit's `Files` (exact or `matchGlob`) → `unit` with the first matching unit in body order;
4. path in `diffFiles`, or kind `missed-context` → `in-change`;
5. otherwise → `out-of-scope`.

`diffFiles` comes from `git diff --name-status <Base>..HEAD` and includes deleted files and both paths of a rename, so a deleted test file's `lowered-standard` finding stays in the change. `missed-context` never leaves the change, so it always blocks.

`registerRule("finding-scope", …)` wraps it; the rule never asks. The pack config is `decisions.finding-scope: { mode: rule }`. `spec_review` calls `decide` per aggregate finding during aggregation and posts one `decision` comment `finding-scope.review-<n>` whose outcome maps each finding index to its route and whose facts hold the diff file list and units (hashed when large). One record per round rather than per finding keeps the issue readable; the decision is still recorded through the seam.

The reviewer's own `scope` is kept in the reviewer summary but never used for routing.

### D6. Route effects

| Route | Effect, idempotent | Blocks the review gate |
|---|---|---|
| `unit` | post `rebuild` marker `rebuild.<unit>.<round>`, then untick `routeUnit` (no-op when pending); its implementer packet lists the aggregate finding (`unitFindings` reads aggregate findings routed to the unit) | until a later round no longer reports it |
| `in-change` | none; next step names `unit_amend --add` with the file | until a later round no longer reports it |
| `out-of-scope` | none; listed as a follow-up in the aggregate and at the next human gate (existing `out-of-scope` payload) | no |
| `question` | `spec_question` with class `non-blocking` and text naming `finding:<aggregateId>:<index>`, skipped when an open or answered question already names that key; non-blocking so it never refuses the rest of the round, while `review-clean` still blocks the gate until it is answered | until the question is answered |
| `record` | none | no |

A pending unit in `review` makes the next step `advance: build` (D8). Back in `build`, the unticked unit is started again. The `rebuild` marker is what distinguishes it: without it, the unit would match "receipted, not ticked" (a receipt for its digest and a pending line) and `unit_finish` would re-tick it without any work. A unit whose latest `rebuild` marker is newer than its latest receipt and `unit-start` is a **rebuild**; it is not receipted-not-ticked, and `unit_start` accepts a green `Verify` at pre for it and records verdict `rebuild`. Requiring a fresh red would refuse every rebuild, because the unit's `Verify` already passes; the proof of the fix is the next review round, which must no longer report the finding at that location and kind. This changes `unit-evidence` "Unit start tool".

### D7. Pull request comments

When an open pull request exists for the change branch, the route stage posts each non-`DISPUTED` aggregate finding whose route is not `record` (so `out-of-scope` follow-ups and a `missed-context` `SUGGESTION` too) as a review comment at its path and line, with a hidden marker `<!-- livespec:finding <aggregateId>:<index> -->`. Existing review comments are listed first and a finding whose marker is present is skipped, so a retried stage posts nothing twice. A finding the forge rejects stays in the aggregate only, and the tool result names it.

### D8. Next step in `review`

New precedence entries, placed after rule 13 and before the gate, only when the phase is `review`:
1. a selected reviewer of the round at HEAD ended `BLOCKED` → `spec_stuck` naming it;
2. a round started at HEAD and not routed → `spec_review` (naming the stage, and the inline packets when no executor);
3. the cap blocks (count reached, latest round routed, its aggregate left a blocking finding, whatever HEAD) → `spec_stuck`;
4. a pending unit → "Return to build to rebuild U<n>", `advance: build`;
5. no routed round at HEAD → `spec_review`;
6. the latest round at HEAD left an `in-change` finding → `unit_amend --add` naming the file;
7. otherwise the gate.

The cap comes before the return to `build`, because the last round's `unit` route has already unticked a unit; checking the cap first stops the loop instead of starting a fourth rebuild that `spec_review` would then refuse. A round in progress always finishes, even at the cap. An `in-change` unit is a normal unit: its `Verify` is a test that exposes the finding, so it is red at pre.

`review-clean` is a gate-only check of the `review` phase, registered in `registerBuiltinChecks`; `CheckGit` gains `head()` so the check can compare the aggregate's head with HEAD. It is gate-only so it never preempts these steps through rule 9 but still refuses the self gate: it passes when the latest aggregate's `head` is HEAD and none of its findings blocks (D6, plus unverified, failed-verification and `missed-context` findings). Rebuttals through `finding_rebut` apply to aggregate findings as to any summary (never to `missed-context`).

`review_rounds` is derived: the number of all aggregate records newer than the latest lifting answer (approved, with a choice) to a stuck report sent while the cap blocked; "sent while the cap blocked" is derived from record order (a `stuck` comment posted after the capped round's aggregate reached the cap and before any newer aggregate), so `spec_stuck` needs no new field and other stuck answers do not reset the count. The count includes every aggregate; only the blocking condition looks at findings: the cap blocks when the latest routed round left a blocking `unit` or `in-change` finding (`question` findings wait for their answer instead). The value reaches `nextStep` through `deriveCommentFacts` in `snapshot.ts`, whose `Caps` gain `reviewRounds`. A `BLOCKED` reviewer is relaunched after any lifting stuck answer newer than its run. A `counter` comment for `review_rounds` is ignored.

Accepted: rebutting a `unit`-routed finding after its unit was unticked still sends the unit through a rebuild; the redo costs one green `Verify` and keeps the rule simple.

The `ship` gate payload gains, through `registerGatePayload`, the latest routed round's number and HEAD, its `DISPUTED` findings with the verifier's reason, rebuttals, `out-of-scope` follow-ups and inline reviewer subjects.

### D9. Reviewer selection and personas

Default `review` entries:
```yaml
subagents:
  - { role: reviewer, subject: change, mode: always, skills: [code-review-and-quality] }
  - { role: reviewer, subject: "persona:security-auditor", mode: auto, when: ["tags:security"], skills: [security-and-hardening] }
  - { role: reviewer, subject: "persona:web-performance-auditor", mode: auto, when: ["tags:perf", "tags:ui"], skills: [performance-optimization] }
  - { role: reviewer, subject: "persona:test-engineer", mode: auto, when: ["units>=3"] }
  - { role: verifier, mode: always }
```
Change facts for selection use the units' tags plus the re-checked tags; `context>=N%` never holds in selection. The `change` subject's persona is `code-reviewer`. A `change` or `persona:<name>` packet adds the required source `file:agents/<name>.md` from the active content tree; the `subagents` schema reports `code-reviewer` as a needed persona when a `change` reviewer entry exists. `phase-entries.ts` skips the `review` phase, whose entries only `spec_review` runs.

### D10. Tag re-check record

`retag.ts` runs the `tags` rule with facts `{ files: diffFiles, title: "", covers: [], doneMeans: [], extraTags: [] }` and keeps tags no unit has. The result is posted as `decision` `tags.review` (no digest), with `source: rule`. Unit bodies and unit decisions are untouched.

### D11. `constraints-not-weakened`

Reads `git diff <Base>..HEAD` with hunks and checks added lines (`+`) and deleted files. `parseGitDiff` reads only file headers, so `standards.ts` has its own small hunk walker for line numbers:
- `\b(it|test|describe)\.(skip|only)\b`, `\bx(it|describe|test)\s*\(` → added skip/only;
- `@ts-ignore`; `@ts-expect-error` with nothing but whitespace or `:` after it; `eslint-disable` in any form;
- a deleted file for which `isTestFile` (`src/evidence/pending.ts`) holds;
- per test file, more removed than added lines matching `\bexpect\s*\(|\bassert\w*\s*\(|\.should\b` → removed assertion, at the first removed line's old line number.
Each is a parent `CRITICAL` `lowered-standard` finding whose evidence quotes the line and, when `specs/constraints.md` exists, cites it. A deleted file's location is `<path>:1`.

### D12. `code-simplification`

When a skill note shows the agent read `code-simplification` in `review`, no unit is titled `simplify`, and the latest round at HEAD left nothing blocking, the gate step's sentence first offers adding a `simplify` unit with `unit_amend --add` (`Kind: refactor`, `Verify` the full test suite). Adding it makes a unit pending, which returns the change to `build` (D8), and the next round reviews the simplified code. `unit_amend` refuses a unit titled `simplify` that is not `Kind: refactor`. The "green before and after" rule is the existing refactor rule of `unit_start`/`unit_finish`.

### D13. Public contract: `routeFinding`

`routeFinding` is exported from `src/review/route.ts` for LS-09. Its signature is the D5 one; LS-09 builds `facts` from a pull request comment or failed check. Its full shape is in plan.md `Contracts`.

## Risks / Trade-offs

- [Running every unit's `Verify` each round is slow] → it is the issue's requirement; runs are sequential and use the existing runner with its timeout.
- [Removed-assertion detection is heuristic] → it counts per file and only flags net removals; a reviewer can still rebut a false positive with evidence through `finding_rebut`.
- [The verifier could refute a real finding] → it sees only the finding, the code and the owning unit, never the implementer's reasoning; refutations are listed in the aggregate and at the ship gate.
- [Parallel children compete for the executor's concurrency] → `fanout.ts` launches all; the executor queues as it already does. Cancelling the tool call aborts every child.
- [A rebuild accepts green at pre] → only for a unit a review finding routed back, and the finding is resolved only by a later completed round.
- [Inline review loses true independence] → the issue allows sequential review without an executor; each inline record carries `agentSource: inline`, which the ship payload shows.

## Migration Plan

None. New records and an additive pack change; existing changes in `review` pick up the new next step on refresh.

## Open Questions

None.
