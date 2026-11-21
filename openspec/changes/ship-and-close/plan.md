# Ship, pull request feedback and close Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** End a livespec change with exactly one reviewed pull request, route pull request feedback back through review, and close the issue only after a human merged.

**Architecture:** Pure decision modules in `src/ship/` (change diff, reviewed HEAD, durable docs rule, pull request body, freshness, feedback mapping, next steps), a per-refresh `shipContext` memo for the git facts, plus four thin tools (`docs_table`, `change_ship`, `change_push`, `change_close`) that wire them to the forge, git and `guardedPush`. Feedback becomes a `review-run` with `source: pull-request`, so LS-08's round, routing and `review_rounds` handle it unchanged; the merge is detected from snapshot state in a new top-precedence next-step rule.

**Tech Stack:** TypeScript (Bun, `tsc --noEmit`), vitest, `yaml`; seams `registerRule`, `registerCheck`, `registerGatePayload`, `registerKind`, `registerLivespecTool`, `pi.events`.

## Global Constraints

- No new dependency. git ≥ 2.38 is needed only for the clean-merge exception; older git falls back to strict equality (ship-phase "Reviewed HEAD").
- `guardedPush` is called only from `src/tools/change-ship.ts` and `src/tools/change-push.ts`, with remote `origin` and refspec `HEAD:refs/heads/<Branch line>`.
- The pull request body says `Refs #<change>` and never holds a closing keyword followed by an issue reference.
- Every forge write is an own marked comment, a versioned body write, a label move, or an existing tool effect; every new tool refuses in a child session and in read-only mode.
- Repository text (code, comments, user-facing strings, commits) in English. Follow `~/.agents/skills/coding-standards/SKILL.md`: one responsibility per file, pure functions for decisions, no god function in a tool.

## Review Focus

1. **The human merges with a squash or a rebase instead of a merge commit.** The change must still move to `close` (merge state comes from `getPullRequest`, not from git ancestry). Pinned in Task 5 (outcome rule test with a squash-merged pull request whose head is not an ancestor of `origin/main`).
2. **The pull request's head branch was deleted after merge.** `refs/remotes/origin/<branch>` may vanish after `git fetch --prune`; the snapshot must keep `pr.merged` and the close flow must not need the pushed head. Pinned in Task 4 (snapshot test with no remote ref) and Task 10 (close test).
3. **A forge comment edited many times or a check re-run with the same name.** Each edit is new feedback once; a re-run that fails again at the same pushed head is not. Pinned in Task 9 (keys test).
4. **A Proposal paragraph with `fixes owner/repo#12` or `Resolved #3` in other casing.** It must be rewritten to `Refs`. Pinned in Task 2 (`pr-body` test table).
5. **Two `change_ship` calls in parallel tool calls.** Only one pull request may result. Pinned in Task 6 (both calls under the evidence lock; second adopts or refuses).

---

## Dependency notes

- tasks.md group dependencies are carried over unchanged. File overlaps that set them: Tasks 3 and 5 both edit `src/engine/next-step.ts`, `state-types.ts`, `card-input.ts` and `ship/context.ts`; Tasks 3 and 4 both add a field to `state-types.ts` (Task 5 waits for both; 3 and 4 add disjoint fields, so a trivial merge); Tasks 6, 7 and 10 edit `src/tools/change-tools.ts` (10 waits for 7); Task 9 edits `src/tools/change-push.ts` (Task 7).
- Task 8 (review changes) only needs Task 1 and can run alongside Tasks 2–7.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `ReviewComment` | modified | adds `id: string; updatedAt: string` | no |
| `Review` | modified | adds `id: string; updatedAt: string` (`state` already exists) | no |
| `PullRequest.author` | modified | adds `author: string` | no |
| `Git.firstParentList` | new | `(range: string) => Promise<string[]>` (`git rev-list --first-parent --reverse <range>`) | no |
| `GateResult.request` / `GateResult.commentId` | modified | adds `request?: string` (the gate comment's request id) and `commentId: string` (its forge comment, for `createdAt`) | no |
| `ChangeState.issue.state` | modified | adds `state: "open" \| "closed"`; `tests/helpers/change-state.ts` defaults it to `open` | no |
| `Session.exec` | new | `exec: GitExec`, the exec `createGit` receives; `guardedPush` uses it | no |
| `staleComment` | new | `(id: string, data: { reason: string; phases: string[]; units?: string[] }) => string` in `src/interaction/stale.ts` | no |
| `humanThreadComments` | new | `(forge: Forge, issue: number, login: string) => Promise<Comment[]>` in `src/ship/freshness.ts` (own = author is login and `parseMarked` finds a marker) | no |
| `shipStale` | new | `(state: ChangeState, gateComment: Comment \| undefined, humans: Comment[]) => string \| undefined` (the reason, or undefined when fresh); the caller finds the ship gate comment by `GateResult.commentId` in `listComments` and passes `humanThreadComments` output. Changed in apply (internal): the one-list form could not tell the own gate comment from own ship/stale comments | no |
| `ShipContext` | new | `{ diff: ChangeDiff; integrationTip: string; facts: DurableFacts; reviewed: { ok: true } \| { ok: false; reason: string }; gatesAtHead: { review: boolean; ship: boolean }; needsShipGate: boolean }` | no |
| `approvedAtHead` | new | `(state: ChangeState, phase: string) => boolean` in `src/engine/locks.ts`: `validApproval` and, for `review`/`ship`, `state.ship?.gatesAtHead?.[phase] !== false` | no |
| `shipContext` | new | `(session: Session, state: Pick<ChangeState, "git" \| "change">) => Promise<ShipContext \| { refused: string }>` in `src/ship/context.ts`; fetch and change diff memoized by HEAD, the rest recomputed per call; `shipFor` wraps it per phase and fails closed in `ship` (apply, internal: narrowed input; ChangeState.ship also carries `durableFacts`) | no |
| `CheckContext.ship` | modified | adds optional `ship?: ShipContext` | no |
| `Git.mergeBase` | new | `(a: string, b: string) => Promise<string>` (`git merge-base a b`) | no |
| `Git.mergeTree` | new | `(a: string, b: string) => Promise<{ tree: string } \| "conflict" \| "unsupported">` (`git merge-tree --write-tree a b`; exit 1 → `conflict`; unknown option → `unsupported`) | no |
| `Git.treeOf` | new | `(commit: string) => Promise<string>` (`git rev-parse <commit>^{tree}`) | no |
| `Git.remoteRef` | new | `(name: string) => Promise<string \| undefined>` (`git rev-parse --verify -q refs/remotes/<name>`) | no |
| `GateResult.headSha` | modified | adds `headSha?: string` from the `gate` comment's `head_sha` | no |
| `ChangeDiff` | new | `{ from: string; entries: DiffEntry[]; files: string[] }` in `src/ship/diff.ts` | no |
| `changeDiff` | new | `(git: Git, base: string \| undefined, integration: string) => Promise<ChangeDiff \| { refused: string }>` | no |
| `filesOutsideUnits` | new | `(files: string[], units: Unit[]) => string[]` (not in any `Files` by exact or `matchGlob`, not under `specs/`) | no |
| `reviewedHead` | new | `(state: ChangeState) => string \| undefined` | no |
| `isReviewed` | new | `(git: Git, reviewed: string \| undefined, head: string, integrationTip: string) => Promise<{ ok: true } \| { ok: false; reason: string }>` in `src/ship/reviewed.ts` | no |
| `ship` marker | new | kind `ship`, id `ship.<pr>.<pushedHead>`, data `{ pr: number; pushedHead: string; confirmed: string[] }` | no |
| `latestShipRecord` | new | `(marked: MarkedComment[]) => ShipRecord \| undefined` in `src/ship/records.ts` | no |
| `pullRequestBody` | new | `(state: ChangeState, review: string) => { title: string; body: string }` in `src/ship/pr-body.ts`; closing keywords regex closing keywords followed by `#n` or `owner/repo#n` (also comma/`and` lists) anywhere in the composed body → `Refs …` (apply: the plan's `$3` named the wrong group) | no |
| `PhaseOutput` | modified | adds `"issue#Durable docs"`; pack `OUTPUTS` likewise | yes (pack) |
| `decisions.durable-docs` | new | pack config `{ mode: rule }`; point `durable-docs`, never asks | yes (pack key) |
| `DurableFacts` | new | `{ files: string[]; added: string[]; capabilities: { new: string[]; modified: string[] }; specs: { capability: string; paths: string[] }[]; rows: { file: string; status: string }[] }` | no |
| `durableDocsRule` | new | `(facts: DurableFacts) => { errors: string[]; confirm: string[]; needsRows: boolean }` in `src/ship/durable-docs.ts` | no |
| `durable-docs` check | new | ship-phase check, not waivable, errors `error`, confirm items `warning` | yes (pack check name) |
| `docs_table` tool | new | params `{ rows: { file: string; status: "updated" \| "not needed"; reason?: string }[] }` | yes (tool API) |
| `ChangeState.pr` | new | `pr?: { number: number; state: "open" \| "closed"; merged: boolean; mergedAt?: string; pushedHead?: string }` | no |
| `advancePhase` | modified | `(forge, n, to, pack, opts?: { merged?: boolean })`; `planMove(pack, labels, to, opts?)` allows `to` = last phase from any phase only with `merged: true` | no |
| `prOutcomeStep` / `shipStep` / `closeStep` | new | `(state: ChangeState, pack: Pack) => Decision \| undefined` in `src/ship/ship-steps.ts`, reading `state.pr`, `state.ship` and `state.issue.state` | no |
| `ChangeState.ship` | new | `ship?: { docsRowsNeeded?: boolean; reviewed?: boolean; needsShipGate?: boolean; gatesAtHead?: { review: boolean; ship: boolean } }`, filled at refresh in `src/hooks/card-input.ts` (git work is not done in `nextStep`); Task 3 fills `docsRowsNeeded`, Task 5 the rest | no |
| `change_ship` tool | new | params `{}` | yes (tool API) |
| `change_push` tool | new | params `{}` | yes (tool API) |
| `ReviewRunData` | modified | adds `source?: "pull-request"; feedbackKeys?: string[]` | no |
| `RouteFacts` | modified | adds `check: boolean` | yes (LS-08 export) |
| `FeedbackItem` | new | `{ key: string; finding: Finding }` in `src/ship/feedback.ts` | no |
| `collectFeedback` | new | `(forge: Forge, pr: number, pushedHead: string, login: string, ingested: Set<string>, permission: (login: string) => Promise<string>) => Promise<FeedbackItem[]>` | no |
| `pollFeedback` | new | `(session: Session) => Promise<{ ingested: number } \| { failed: string } \| { skipped: true }>`, single-flight, in `src/ship/feedback-poll.ts` | no |
| `close-summary` marker | new | kind `close-summary`, ids `close-summary.<change>` and `close-summary.initiative`, data `{ pr: number; mergedAt?: string; units: string[]; durableDocs: string[]; reviewRounds: number; abandoned?: string }` | no |
| `change_close` tool | new | params `{ abandon?: string }` | yes (tool API) |
| `livespec:change-closed` event | new | `{ change: number; pr: number; initiative?: number; abandoned?: true }` | yes (event) |
| `livespec:initiative-closed` event | new | `{ initiative: number; changes: number[] }` | yes (event) |

---

## Task 1: Forge, git and state ports — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4, 1.5
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/forge/types.ts`, `src/forge/github.ts`, `src/forge/gitea.ts`, `src/forge/gitea-dto.ts`, `src/engine/git.ts`, `src/engine/locks.ts`, `src/engine/state-types.ts`, `src/engine/snapshot.ts` (issue state), `src/hooks/session.ts` (`Session.exec`), `src/interaction/complete-gate.ts`
- Create: `src/interaction/stale.ts`
- Test: `tests/forge/contract.ts`, `tests/forge/memory-forge.ts`, `tests/forge/fake-gh/state.ts`, `tests/forge/fake-gh/api.ts`, `tests/forge/fake-gitea.ts`, `tests/engine/git.test.ts`, `tests/engine/locks.test.ts`, `tests/helpers/change-state.ts`, `tests/tools/helpers.ts`, `tests/hooks/fake-pi.ts`, `tests/interaction/stale.test.ts`

**Interfaces:**
- Produces: `ReviewComment`, `Review`, `PullRequest.author`, `Git.mergeBase`, `Git.mergeTree`, `Git.treeOf`, `Git.remoteRef`, `Git.firstParentList`, `GateResult.headSha`, `GateResult.request`, `GateResult.commentId`, `ChangeState.issue.state`, `Session.exec`, `staleComment` (Contracts).

- [ ] **Step 1: Write failing contract tests:** `listReviewComments` and `listReviews` return a non-empty `id` and `updatedAt`; an edited review comment changes `updatedAt`; `getPullRequest` returns the opener as `author`.
- [ ] **Step 2: Write failing git tests** on `makeRepo()`: `mergeBase`; `mergeTree` of a clean merge equals `treeOf` of the `--no-ff` merge commit; conflicting edits → `conflict`; a stderr with `unknown option` → `unsupported` (exec stub); `remoteRef("origin/x")` is `undefined` when absent; `firstParentList` of a branch that merged main with its own commit lists only the branch's first-parent commits.
- [ ] **Step 3: Write failing tests:** a `gate` comment with `head_sha: c3` and `request: r7` gives `gates.review.headSha === "c3"` and `request === "r7"`; snapshot `issue.state` is `closed` for a closed issue; `staleComment("stale.x", { reason: "r", phases: ["ship"] })` parses back as a `stale` marker with those phases; existing `complete-gate` tests still pass.
- [ ] **Step 4:** Run `bunx vitest run tests/forge tests/engine tests/interaction`. Expected: FAIL on the new tests.
- [ ] **Step 5: Implement.** GitHub: `id: String(c.id)`, `updatedAt: c.updated_at` (reviews: `submitted_at`), `author: user.login`; Gitea likewise from DTO fields, extending the DTO guards. `mergeTree` catches `GitError` and inspects stderr. `Session.exec` defaults to `defaultGitExec`; `toolHarness` sets it to its recording exec. `FakePi.api.events = { emit: vi.fn(), on: vi.fn() }`.
- [ ] **Step 6:** Run the Step 4 command, then `bun run typecheck`. Expected: PASS, 0 errors.
- [ ] **Step 7:** Commit `feat(forge): ports for ship (review ids, PR author, merge-tree, stale writer)`.

---

## Task 2: Ship core — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5
**Difficulty:** Hard
**Blocked by:** Task 1

**Files:**
- Create: `src/ship/diff.ts`, `src/ship/reviewed.ts`, `src/ship/records.ts`, `src/ship/pr-body.ts`, `src/ship/freshness.ts`
- Test: `tests/ship/diff.test.ts`, `tests/ship/reviewed.test.ts`, `tests/ship/records.test.ts`, `tests/ship/pr-body.test.ts`, `tests/ship/freshness.test.ts`

**Interfaces:**
- Consumes: Task 1 ports; `diffNameStatus`, `diffFilesOf`, `matchGlob`, `parseMarked`, `gateDigest`.
- Produces: `ChangeDiff`, `changeDiff`, `filesOutsideUnits`, `reviewedHead`, `isReviewed`, `ship` marker, `latestShipRecord`, `pullRequestBody`, `humanThreadComments`, `shipStale` (Contracts).

- [ ] **Step 1: Write failing diff tests** on repos with a bare `origin`: "Integration merge excluded", "Fetch fails" (`from === Base`), a rename lists both paths, `filesOutsideUnits(["src/extra.ts","specs/a/spec.md","src/a.ts"], [U1 Files src/a.ts])` → `["src/extra.ts"]`, a glob `src/limit/**` matches.
- [ ] **Step 2: Write failing reviewed tests:** "Equal to the reviewed SHA"; "Commit after review" (reason names `d4` and `c3`); "Clean integration merge" **where `origin/main` has its own new commit**; "Conflicted merge"; a clean merge amended by hand → not reviewed; a second parent not an ancestor of the integration tip → not reviewed; `unsupported` → only equality, reason says git is too old; `reviewed` undefined → reason names the review gate.
- [ ] **Step 3: Write failing records, body and freshness tests:** `ship` kind registered; `latestShipRecord` returns the last record. Body holds the Proposal's first paragraph, units with `[x]`/`[ ]`, the Durable docs table, the review text, and ends with `Refs #<n>`; Review Focus 4 table: `Closes #12`, `fixes owner/repo#12`, `Resolved: #3`, `FIXED #4` → `Refs …`, `prefix #5` unchanged. `shipStale`: a human comment created after the ship `gate` comment → reason; one edited after → reason; the forge approval comment (created before the `gate` comment) → fresh; own marked comments ignored; the issue's `gateDigest` differing from the request record's `gate_digest` → reason.
- [ ] **Step 4:** Run `bunx vitest run tests/ship`. Expected: FAIL.
- [ ] **Step 5: Implement `diff.ts`** per design D2 (`fetch` → `mergeBase` → `diffNameStatus`, each failure falling back to `Base`; neither → `{ refused }`).
- [ ] **Step 6: Implement `reviewed.ts`.** Walk `firstParentList(<reviewed>..HEAD)` with `prev = reviewed`; each commit needs `parents(c) = [prev, p2]`, `isAncestor(p2, integrationTip)` and `mergeTree(prev, p2)` equal to `{ tree: treeOf(c) }`.
- [ ] **Step 7: Implement `records.ts`, `pr-body.ts` and `freshness.ts`** (the gate comment's `createdAt` comes from the forge comment matching the gate result in `state.marked`; the request record is found by `GateResult.request`).
- [ ] **Step 8:** Run `bunx vitest run tests/ship`. Expected: PASS.
- [ ] **Step 9:** Commit `feat(ship): change diff, reviewed head, records, body and freshness`.

---

## Task 3: Durable docs — implements 3

**Covers:** 3.1, 3.2, 3.3, 3.4, 3.5
**Difficulty:** Hard
**Blocked by:** Task 2

**Files:**
- Create: `src/ship/durable-docs.ts`, `src/ship/context.ts`, `src/ship/docs-table.ts`, `src/tools/docs-table.ts`
- Modify: `src/engine/pack-types.ts`, `src/engine/pack-schema.ts`, `src/engine/next-step.ts` (`missingOutputSentence` only), `src/engine/state-types.ts` (`ChangeState.ship`), `src/engine/registry.ts` (`CheckContext.ship`), `src/engine/checks.ts` (register the check; fill `ctx.ship`), `src/hooks/card-input.ts`, `src/decide/registry.ts` (`registerBuiltinRules`), `src/tools/change-tools.ts`, `src/packs/agent-skills.yaml`, `tests/fixtures/agent-skills.pack.json`
- Test: `tests/ship/durable-docs.test.ts`, `tests/ship/context.test.ts`, `tests/ship/docs-table.test.ts`, `tests/tools/docs-table.test.ts`, `tests/engine/pack-schema.test.ts`, `tests/engine/pack-load.test.ts`, `tests/engine/next-step.test.ts`

**Interfaces:**
- Consumes: `changeDiff`, `parseSpec`, `integrationBranch(session.config.project, git)`, `registerRule`, `registerCheck`, `registerGatePayload`, `prepareWrite`, `withEvidenceLock`, `childRefusal`.
- Produces: `DurableFacts`, `durableDocsRule`, `ShipContext`, `shipContext`, `CheckContext.ship`, the `durable-docs` check and payload section, `docs_table`, `ChangeState.ship.docsRowsNeeded` (Contracts).

- [ ] **Step 1: Write failing rule tests:** "Capability code without a spec row" (confirm item names `rate-limit` and `src/limit/cap.ts`), "Constraints without a decision" (error), "Constraints with a decision" (only a `specs/constraints.md` row; confirm item names it and `specs/decisions/0007-cap.md`), "Changed durable doc without a row", a `new [cache]` capability without an `updated` `specs/product.md` row → error, an `updated` row not in the diff → error, `needsRows` false for "Nothing durable touched".
- [ ] **Step 2: Write failing context test:** two `shipContext` calls at the same HEAD run `git fetch` once (exec spy).
- [ ] **Step 3: Write failing table and tool tests:** rows ↔ text round trip keeps other sections byte for byte; "Updated row not in the diff", "Not needed with a reason" (row text `| specs/glossary.md | not needed — no new term |`), "Hard rule row", empty reason refuses, wrong phase refuses, child session refuses.
- [ ] **Step 4: Write failing pack and next-step tests:** "Durable docs output accepted"; fixture gains `ship.outputs: ["issue#Durable docs"]`, `ship.checks: ["durable-docs"]`, `decisions.durable-docs.mode: rule` ("Default pack contents", "Spot check"); "Missing table" names `docs_table`; `docsRowsNeeded: false` and no rows → no missing output.
- [ ] **Step 5:** Run `bunx vitest run tests/ship tests/tools/docs-table.test.ts tests/engine`. Expected: FAIL.
- [ ] **Step 6: Implement** the rule, `durableFacts`, the check (reads `ctx.ship`; outside `ship` it reports nothing), the payload provider ("Needs your confirmation:" with confirm items, `not needed` reasons verbatim, new decision files), `shipContext` (fetch and change diff memoized on the session by HEAD), the output (`missingOutputSentence` returns `Write the Durable docs table with docs_table.` when `state.ship?.docsRowsNeeded !== false` and `state.change.durableDocs` is empty), and `docs_table` (versioned body write, one retry after re-reading, under `withEvidenceLock`).
- [ ] **Step 7:** Run the Step 5 command. Expected: PASS.
- [ ] **Step 8:** Commit `feat(ship): durable docs table, rule, check and ship context`.

---

## Task 4: Pull request state and advance — implements 4

**Covers:** 4.1, 4.2
**Difficulty:** Normal
**Blocked by:** Task 2

**Files:**
- Create: `src/ship/pull-request.ts`
- Modify: `src/engine/state-types.ts` (`ChangeState.pr`), `src/engine/snapshot.ts`, `src/engine/advance.ts`, `src/hooks/session.ts` (derived advance)
- Test: `tests/engine/snapshot.test.ts`, `tests/engine/advance.test.ts`, `tests/hooks/session.test.ts`

**Interfaces:**
- Consumes: `Git.remoteRef`, `Forge.getPullRequest`.
- Produces: `ChangeState.pr`, `advancePhase(..., { merged })`, `planMove(..., { merged })` (Contracts).

- [ ] **Step 1: Write failing tests:** "Pull request state"; "Unreadable pull request" (warning names `#41`); read-only mode → `pr` absent plus warning; Review Focus 2 (no remote ref → `pushedHead` undefined, `merged` kept); "Merged pull request moves to close"; "Close without merge refused"; existing moves unchanged; the session's derived advance passes `merged: true` when `state.pr.merged`.
- [ ] **Step 2:** Run `bunx vitest run tests/engine/snapshot.test.ts tests/engine/advance.test.ts tests/hooks/session.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `pull-request.ts` (`readPullRequest(forge, git, header, branch)`), the snapshot field, `planMove` allowing `to` = last phase from any phase only with `merged`, and the session call `advancePhase(forge, n, to, pack, { merged: state.pr?.merged === true })`.
- [ ] **Step 4:** Run the Step 2 command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(engine): pull request state and merged advance`.

---

## Task 5: Next steps for ship and close — implements 5

**Covers:** 5.1, 5.2, 5.3
**Difficulty:** Hard
**Blocked by:** Task 3, Task 4

**Files:**
- Create: `src/ship/ship-steps.ts`
- Modify: `src/ship/context.ts`, `src/hooks/card-input.ts`, `src/engine/state-types.ts`, `src/engine/locks.ts`, `src/engine/next-step.ts`
- Test: `tests/ship/ship-steps.test.ts`, `tests/engine/next-step.test.ts`, `tests/ship/context.test.ts`, `tests/hooks/card-input.test.ts` (new), `tests/e2e/gates-flow.test.ts`

**Interfaces:**
- Consumes: `isReviewed`, `reviewedHead`, `latestShipRecord`, `durableDocsRule`, `shipContext`, `ChangeState.pr`, `GateResult.headSha`.
- Produces: `prOutcomeStep`, `shipStep`, `closeStep`, `ChangeState.ship.reviewed/needsShipGate` (Contracts).

- [ ] **Step 1: Write failing context tests:** `needsShipGate` true when `diffNames(pushedHead, "HEAD", "specs/")` is non-empty, or when a confirm item is missing from the latest `ship` record, false otherwise; after a new `ship` record at the same HEAD it turns false (not memoized); `gatesAtHead.review` is true at the reviewed SHA and after a clean merge, false after a fix commit; `buildCardInput` fills `state.ship.{reviewed,needsShipGate,gatesAtHead}` in `ship` and `gatesAtHead` in `review`.
- [ ] **Step 2: Write failing next-step tests:** "Review approval at an older HEAD"; "Clean merge keeps the approval"; a ship gate approved at an older HEAD counts as superseded and its waivers no longer apply; "Merge seen before checks"; "Merge seen in review"; "Merged during a fix round"; "Human merged"; Review Focus 1 (squash merge); "Pull request closed unmerged"; "Abandoned change has nothing left to do"; "Waiting for merge"; "Unreviewed commits go back to review"; "Fix needs the ship gate again"; "Reviewed fix ready to push"; "Close pending"; "Last phase"; "Ship approved" (flow-engine and phase-gates variants); "Waived ship gate stays in ship"; `pr` undefined in `ship` with a `PR:` line → the warning is shown and no outcome rule fires.
- [ ] **Step 3:** Run `bunx vitest run tests/ship tests/engine/next-step.test.ts tests/e2e/gates-flow.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement the refresh facts.** `shipContext` adds `reviewed` (`isReviewed` against `reviewedHead`), `gatesAtHead` (`isReviewed` against each gate's `headSha`) and `needsShipGate`; `card-input.ts` copies them into `state.ship` in `review` and `ship`.
- [ ] **Step 5: Implement head-bound gates** with `approvedAtHead(state, phase)` in `src/engine/locks.ts`, used by `gateResultDecision` (false → the superseded sentence) and by `waivedChecks`. `reviewedHead` keeps reading `validApproval` without it.
- [ ] **Step 6: Implement `ship-steps.ts`** with the exact sentences: merged → `The pull request #<n> is merged: move to close.` (`advance: close`); closed → `The pull request #<n> was closed without merge: reopen it on the forge, or abandon the change with change_close --abandon <reason>.`; unreviewed → `New commits after the reviewed SHA need review: move to review.` (`advance: review`); waiting → `Wait for a human to merge #<n> on the forge.`; re-confirmation → `Ready for the ship gate.`; push → `Run change_push to update #<n>.`; close → `Run change_close.`. Insert `prOutcomeStep` right after label repair and `shipStep`/`closeStep` after `reviewPhase`; the approved ship sentence becomes `The ship gate is approved: run change_ship.`; in the last phase `gate()` says `The flow has no further phase.` only when the issue is closed.
- [ ] **Step 7:** Run the Step 3 command plus `tests/hooks`. Expected: PASS.
- [ ] **Step 8:** Commit `feat(engine): ship and close next steps with head-bound gates`.

---

## Task 6: Ship tool — implements 6

**Covers:** 6.1, 6.2
**Difficulty:** Hard
**Blocked by:** Task 5

**Files:**
- Create: `src/tools/change-ship.ts`
- Modify: `src/tools/change-tools.ts`, `src/guard/push.ts` (comment)
- Test: `tests/tools/change-ship.test.ts`, `tests/guard/push-callers.test.ts`

**Interfaces:**
- Consumes: `shipContext`, `filesOutsideUnits`, `isReviewed`, `shipStale`, `humanThreadComments`, `staleComment`, `pullRequestBody`, `ship` records, `guardedPush(session.exec, root, "origin", "HEAD:refs/heads/<branch>")`, `prepareWrite`, `withEvidenceLock`, `childRefusal`.
- Produces: `change_ship` (params `{}`).

- [ ] **Step 1: Write failing tests** with `toolHarness` and a bare `origin`: "One pull request", "Commit after the reviewed SHA", "File outside every unit", "Another pull request open", "Retry after a partial ship" (memory forge fails the body write once; second call adopts by `author` and `Refs`), "Human comment after the ship gate" (refuses and posts `stale` listing `ship`), "Forge approval then ship", "Clean merge after the ship gate", the gate digest changed → stale refusal, stale → ship gate approved again → a new human comment → stale again with a new `stale` comment (id holds the comment's `id@updatedAt`), "Ship gate not approved", "Refspec from the issue" (recording exec: `push -- origin HEAD:refs/heads/livespec/rate-limit`), "Child ships", wrong branch refuses, `PR:` present refuses naming `change_push`, Review Focus 5 (two concurrent calls → one pull request).
- [ ] **Step 2: Update `push-callers.test.ts`** to "No tool calls the push path": only `change-ship.ts` and `change-push.ts` may import `src/guard/push.ts`.
- [ ] **Step 3:** Run `bunx vitest run tests/tools/change-ship.test.ts tests/guard`. Expected: FAIL.
- [ ] **Step 4: Implement `change_ship`** in the order of design D5, under `withEvidenceLock`; a stale freshness result alone writes `staleComment("stale.ship.<commentId>@<updatedAt>", { reason, phases: ["ship"] })` (or `stale.ship.digest.<gateDigest>` for a body edit) and stops. The ship gate counts when it is approved, not staled, and HEAD `isReviewed` against its `headSha`; the gate comment's `createdAt` comes from `GateResult.commentId`.
- [ ] **Step 5:** Register it and update the `push.ts` comment.
- [ ] **Step 6:** Run the Step 3 command. Expected: PASS.
- [ ] **Step 7:** Commit `feat(ship): change_ship`.

---

## Task 7: Push tool — implements 7

**Covers:** 7.1
**Difficulty:** Normal
**Blocked by:** Task 6

**Files:**
- Create: `src/tools/change-push.ts`
- Modify: `src/tools/change-tools.ts`
- Test: `tests/tools/change-push.test.ts`

**Interfaces:**
- Consumes: as Task 6, plus `ChangeState.ship.needsShipGate`.
- Produces: `change_push` (params `{}`); `runChangePush(params, deps: { poll: ShipPoll })` with `ShipPoll = (session: Session) => Promise<{ ingested: number } | { failed: string } | { skipped: true }>`; the registered tool uses `{ skipped: true }` until Task 9.

- [ ] **Step 1: Write failing tests:** "Unreviewed commits refused", "Reviewed fix pushed", "Feedback arrived" (poll `{ ingested: 1 }` → refuses, no push), poll `{ failed }` → refuses, "Fix touches constraints", a new confirm item missing from the latest `ship` record → needs the ship gate, "Remote moved", no pushed head → refuses, dirty tree, wrong branch, merged or closed pull request, `durable-docs` error → each refuses, HEAD equal to the pushed head → nothing to push, child refuses.
- [ ] **Step 2:** Run `bunx vitest run tests/tools/change-push.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per design D5 under `withEvidenceLock`, and register it.
- [ ] **Step 4:** Run the Step 2 command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ship): change_push`.

---

## Task 8: Review changes for feedback rounds — implements 8

**Covers:** 8.1, 8.2
**Difficulty:** Normal
**Blocked by:** Task 1

**Files:**
- Modify: `src/review/records.ts`, `src/review/round.ts`, `src/review/effects.ts`, `src/review/route.ts`, `src/review/stages.ts` (route facts `check`), `src/review/next.ts`
- Test: `tests/review/round.test.ts`, `tests/review/effects.test.ts`, `tests/review/route.test.ts`, `tests/review/next.test.ts`

**Interfaces:**
- Produces: `ReviewRunData.source`, `ReviewRunData.feedbackKeys`, `RouteFacts.check` (Contracts).

- [ ] **Step 1: Write failing tests:** "Failing check" route `in-change`; "Feedback round kept on a new HEAD" (`nextStage` returns `aggregate` for the old-head `pull-request` run; after routing it, the next call starts round 4 at the new HEAD); the cap blocks a new start but not the aggregate and route of a `pull-request` run; "Feedback round not posted back"; "Failing check finding" names `unit_amend --add` and `ci/test`; existing "New HEAD restarts the round" still passes.
- [ ] **Step 2:** Run `bunx vitest run tests/review`. Expected: FAIL.
- [ ] **Step 3: Implement.** `isRunData` accepts the two optional fields; `round.ts` skips the stale-HEAD replacement for `source: pull-request` and uses the run's `head` for its stage lookups; `effects.ts` skips `createReviewComment` for such a round; `route.ts` adds step 3 (`facts.check`), computed in `stages.ts` from `location.startsWith("check:")`.
- [ ] **Step 4:** Run the Step 2 command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(review): pull request feedback rounds`.

---

## Task 9: Feedback mapping and poll — implements 9

**Covers:** 9.1, 9.2
**Difficulty:** Hard
**Blocked by:** Task 4, Task 7, Task 8

**Files:**
- Create: `src/ship/feedback.ts`, `src/ship/feedback-poll.ts`
- Modify: `src/hooks/session.ts` (`startSession`), `src/commands/next.ts`, `src/tools/change-push.ts` (default poll)
- Test: `tests/ship/feedback.test.ts`, `tests/ship/feedback-poll.test.ts`, `tests/hooks/session.test.ts`, `tests/commands/next.test.ts`

**Interfaces:**
- Consumes: Task 1 forge ids, `ChangeState.pr`, `roundNumber`, `reviewRunComment`, `staleComment`, `advancePhase`, `untrusted` (`src/hooks/phase-card.ts`), `getPermission`.
- Produces: `FeedbackItem`, `collectFeedback`, `pollFeedback` (Contracts).

- [ ] **Step 1: Write failing mapping tests:** "Shared account", "Own finding comment", "Reader comment", "Located review comment", "Comment without location", "Approved review body", "Failing CI check" (key `check:<pushedHead>:ci/test`), "Edited comment", Review Focus 3, human text inside `<untrusted>`.
- [ ] **Step 2: Write failing poll tests:** "Not in ship", "Poll fails at session start", "Polled twice", "Back to review" (order: `review-run` with `source: pull-request`, `stale.feedback.<round>` listing `review` and `ship`, label moves to `review`), "Counts toward the cap", an unrouted round → skipped, single-flight (two concurrent calls → one round), `/livespec next` polls after approvals.
- [ ] **Step 3:** Run `bunx vitest run tests/ship tests/hooks/session.test.ts tests/commands`. Expected: FAIL.
- [ ] **Step 4: Implement `feedback.ts`** (own = author is login and `parseMarked` finds a marker or the body holds `<!-- livespec:finding `; permission memo per poll, fail closed) and `feedback-poll.ts` (single-flight on the session like `pollApprovals`); call it after `pollApprovals` in `startSession` and `/livespec next`; make it `change_push`'s default poll.
- [ ] **Step 5:** Run the Step 3 command. Expected: PASS.
- [ ] **Step 6:** Commit `feat(ship): pull request feedback poll`.

---

## Task 10: Close — implements 10

**Covers:** 10.1, 10.2
**Difficulty:** Normal
**Blocked by:** Task 5, Task 6, Task 7

**Files:**
- Create: `src/ship/close.ts`, `src/tools/change-close.ts`
- Modify: `src/tools/change-tools.ts`
- Test: `tests/ship/close.test.ts`, `tests/tools/change-close.test.ts`

**Interfaces:**
- Consumes: `tickChange`, `parseInitiative` (`src/core/initiative.ts`), `ChangeState.pr`, `reviewRounds`, `registerKind`, `pi.events` (the `ExtensionAPI` passed at registration; `FakePi` spy from Task 1).
- Produces: `close-summary` marker, `change_close` (params `{ abandon?: string }`), events (Contracts).

- [ ] **Step 1: Write failing tests:** "Close after merge" (one `livespec:change-closed` with `{ change, pr }`), "Not merged", "Last change of an initiative" (tick, `close-summary.initiative`, tracking issue closed, both events in order), "Retry after a partial close", "Retry after the initiative closed", "Abandon" (`abandoned: true`, entry unchecked), empty abandon reason refuses, abandon with an open pull request refuses, child refuses, Review Focus 2.
- [ ] **Step 2:** Run `bunx vitest run tests/ship/close.test.ts tests/tools/change-close.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** design D11; each step checks its own record or state first; events are emitted only when this call closed the change issue. A rerun after the issue is closed finds no open change and refuses through `requireChange`, emitting nothing; the closed-issue next steps are pinned at `nextStep` level only (the card never resolves a closed issue).
- [ ] **Step 4:** Run the Step 2 command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ship): change_close`.

---

## Task 11: End-to-end flow and docs — implements 11

**Covers:** 11.1, 11.2, 11.3
**Difficulty:** Normal
**Blocked by:** Task 9, Task 10

**Files:**
- Create: `tests/e2e/ship-flow.test.ts`
- Modify: `docs/architecture.md`, `docs/glossary.md`

**Interfaces:**
- Consumes: every tool of Tasks 3–10 through the harness used by `tests/e2e/review-flow.test.ts`.

- [ ] **Step 1: Write the e2e test** following issue #32 "Done when": from an approved review gate, `docs_table`, the ship gate, and `change_ship` opens exactly one pull request; a new commit makes `change_ship` refuse; a failing CI check on the pushed head becomes a routed `in-change` finding on the same pull request ("Same pull request"), the change returns to `review`, `change_push` refuses the unreviewed fix and pushes after the review gate passes again; a human merge moves the change to `close`; `change_close` closes the issue, which stayed open until then.
- [ ] **Step 2:** Run `bunx vitest run tests/e2e/ship-flow.test.ts`. Expected: PASS (fix wiring gaps in the owning modules if not).
- [ ] **Step 3: Update docs.** `docs/architecture.md`: Ship, Pull request feedback and Close sections (reviewed SHA and first-parent clean-merge exception, head-bound gates, `Refs`, feedback mapping and ingest-once, re-confirmation, merge detection in any phase, abandon, in-process events, git ≥ 2.38) and the tool list; `docs/glossary.md`: add "Reviewed SHA", keep "Integration branch".
- [ ] **Step 4:** Run `bun run typecheck && bun run test`. Expected: 0 type errors, all tests pass.
- [ ] **Step 5:** Commit `docs: ship, feedback and close`.

---

## Scenario → test

- change-close / Human merged → `tests/engine/next-step.test.ts` "Human merged" and `tests/e2e/ship-flow.test.ts`
- change-close / Merged during a fix round → `tests/engine/next-step.test.ts` "Merged during a fix round"
- change-close / Close after merge → `tests/tools/change-close.test.ts` "Close after merge"
- change-close / Not merged → `tests/tools/change-close.test.ts` "Not merged"
- change-close / Last change of an initiative → `tests/ship/close.test.ts` "Last change of an initiative"
- change-close / Retry after a partial close → `tests/ship/close.test.ts` "Retry after a partial close"
- change-close / Retry after the initiative closed → `tests/ship/close.test.ts` "Retry after the initiative closed"
- change-close / Pull request closed unmerged → `tests/engine/next-step.test.ts` "Pull request closed unmerged"
- change-close / Abandoned change has nothing left to do → `tests/engine/next-step.test.ts` "Abandoned change has nothing left to do"
- change-close / Abandon → `tests/tools/change-close.test.ts` "Abandon"
- change-close / Close pending → `tests/engine/next-step.test.ts` "Close pending"
- command-guards / No tool calls the push path → `tests/guard/push-callers.test.ts`
- command-guards / Refspec from the issue → `tests/tools/change-ship.test.ts` "Refspec from the issue"
- finding-routing / Seeded defect routed to its unit, Changed file outside every unit, Untouched file, Deleted test file stays in the change, Missed context outside the diff, Suggestion → existing `tests/review/route.test.ts` (unchanged)
- finding-routing / Failing check → `tests/review/route.test.ts` "Failing check"
- finding-routing / No pull request, Retried stage → existing `tests/review/effects.test.ts`
- finding-routing / Feedback round not posted back → `tests/review/effects.test.ts` "Feedback round not posted back"
- flow-engine / State from fixture issue, Stale state, Ambiguous phase, Pending request and lock from comments, Started unit from comments, Done unit is never started → existing `tests/engine/snapshot.test.ts`
- flow-engine / Pull request state, Unreadable pull request → `tests/engine/snapshot.test.ts`
- flow-engine / No unit ready, Blocking question first, Missing output, Not started, Next unit, Human gate ready, Pending gate request, Stuck report first, Frozen unit, Dismissed gate, Blocked unit asks for a stuck report, Started unit before the next unit, Review round before the gate, Waived check does not hold the next step → existing `tests/engine/next-step.test.ts`
- flow-engine / Last phase, Ship approved, Review approval at an older HEAD, Clean merge keeps the approval, Merge seen before checks, Merge seen in review → `tests/engine/next-step.test.ts`
- flow-engine / Forward move, Skip refused, Partial failure, Build complete → existing `tests/engine/advance.test.ts`
- flow-engine / Merged pull request moves to close, Close without merge refused → `tests/engine/advance.test.ts`
- flow-pack / Default pack loads, Default pack contents, Spot check → `tests/engine/pack-load.test.ts` (fixture updated)
- flow-pack / Wrong gate value, Unknown key, Requires cycle, Model key rejected, YAML syntax error → existing `tests/engine/pack-schema.test.ts`
- flow-pack / Durable docs output accepted → `tests/engine/pack-schema.test.ts`
- phase-gates / Waive at the gate, Approve without waiving, Define approved, Old approval not reused after a cascade, Superseded result does not fall back, Failed move retried, Changes requested, Dismissed → existing `tests/interaction` and `tests/e2e/gates-flow.test.ts`
- phase-gates / Waived ship gate stays in ship, Ship approved → `tests/e2e/gates-flow.test.ts` (sentence updated)
- pull-request-feedback / Not in ship, Poll fails at session start, Polled twice, Back to review, Counts toward the cap → `tests/ship/feedback-poll.test.ts`
- pull-request-feedback / Shared account, Own finding comment, Reader comment, Located review comment, Comment without location, Approved review body, Failing CI check, Edited comment → `tests/ship/feedback.test.ts`
- pull-request-feedback / Same pull request → `tests/e2e/ship-flow.test.ts`
- review-phase / Round started, Resumed after an interruption, No Base, Unit not done, New HEAD restarts the round → existing `tests/review/round.test.ts` and `tests/tools/spec-review.test.ts`
- review-phase / Feedback round kept on a new HEAD → `tests/review/round.test.ts`
- review-phase / Back to build, Reviewer blocked, In-change finding → existing `tests/review/next.test.ts`
- review-phase / Failing check finding → `tests/review/next.test.ts`
- ship-phase / Integration merge excluded, Fetch fails → `tests/ship/diff.test.ts`
- ship-phase / Equal to the reviewed SHA, Commit after review, Clean integration merge, Clean merge while the integration branch moved, Conflicted merge → `tests/ship/reviewed.test.ts`
- ship-phase / Missing table, Nothing durable touched → `tests/engine/next-step.test.ts` and `tests/ship/durable-docs.test.ts`
- ship-phase / Updated row not in the diff, Not needed with a reason, Hard rule row → `tests/tools/docs-table.test.ts`
- ship-phase / Capability code without a spec row, Constraints without a decision, Constraints with a decision, Changed durable doc without a row → `tests/ship/durable-docs.test.ts`
- ship-phase / One pull request, Commit after the reviewed SHA, File outside every unit, Another pull request open, Retry after a partial ship, Human comment after the ship gate, Forge approval then ship, Clean merge after the ship gate, Ship gate not approved → `tests/tools/change-ship.test.ts`
- ship-phase / Closing keyword in the Proposal → `tests/ship/pr-body.test.ts`
- ship-phase / Unreviewed commits refused, Reviewed fix pushed, Feedback arrived, Fix touches constraints, Remote moved → `tests/tools/change-push.test.ts`
- ship-phase / Child ships → `tests/tools/change-ship.test.ts` "Child ships"
- ship-phase / Waiting for merge, Unreviewed commits go back to review, Fix needs the ship gate again, Reviewed fix ready to push → `tests/engine/next-step.test.ts` and `tests/ship/ship-steps.test.ts`
