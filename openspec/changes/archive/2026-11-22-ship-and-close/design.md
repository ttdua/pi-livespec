## Context

- **Push path.** `src/guard/push.ts` exports `guardedPush(exec, root, remote, refspec)`, the only code that runs `git push`; the guard blocks every agent `git push`, `gh pr create` and `tea pr …`. No tool calls it yet (command-guards "Guarded push").
- **Forge.** Both adapters implement `getPullRequest`, `findOpenPullRequest(head)`, `listPullRequests`, `createPullRequest`, `listComments` (a pull request's conversation is its issue thread), `listReviews`, `listReviewComments` and `getChecks(ref)`. `ReviewComment` and `Review` carry no `id` or `updatedAt`, so they cannot be ingested once.
- **Engine.** `nextStep` is a list of precedence rules ending in `gate`; at `ship` an approved gate only says "ready to ship", and `close` (gate `none`, no successor) says the flow has no further phase. `advancePhase` already allows moving back. `GateResult` has no `head_sha`, though the `gate` comment stores it.
- **Review (LS-08).** A round is derived from `review-run` and aggregate `finding-summary` records (`src/review/round.ts`). A `review-run`'s `parentFindings` are merged into the aggregate with `from: parent`, skip the verifier and are routed by `routeFinding`; `review_rounds` counts aggregates. The route stage posts aggregate findings as pull request review comments with `<!-- livespec:finding <key> -->`.
- **Issue format.** `parseChange` already reads `PR:` and the `## Durable docs` table (`| File | Status |`); `tickChange` exists; `CHANGE_BODY_TEMPLATE` has an empty `## Durable docs` section.
- **Hooks.** `session_start` runs `pollApprovals` then shows the card; `/livespec next` polls approvals first. Pi offers `pi.events.emit(name, data)` for inter-extension events.

## Goals / Non-Goals

**Goals:**
- One rule for "reviewed HEAD", shared by `change_ship` and `change_push`.
- Pull request feedback reuses LS-08's round, routing and counter with no second loop.
- Every write is idempotent and resumable from forge records, as elsewhere in livespec.

**Non-Goals:**
- Small-fix lane, initiatives proposing, `Depends` readiness, park/resume (LS-09b, LS-09c).
- The `behavior-change` record and drift audit (LS-10).
- Merging, force-pushing or rebasing.

## Decisions

### D1. Module layout: `src/ship/`, one responsibility per file

| File | Responsibility |
|---|---|
| `diff.ts` | The change diff: merge base of HEAD and the integration branch tip, the changed entries (both paths of a rename), and `filesOutsideUnits`. |
| `reviewed.ts` | `reviewedHead(state)` (the valid review gate's `head_sha`) and `isReviewed(git, reviewed, head, integrationTip)`. Pure over a small git port. |
| `durable-docs.ts` | The `durable-docs` rule (pure facts → errors and confirm items), the `durable-docs` check, and the ship payload section. |
| `docs-table.ts` | Table rows ↔ `## Durable docs` section text, byte-stable for rows it did not change. Pure. |
| `context.ts` | `shipContext(session)`: the per-refresh memo of the change diff, reviewed HEAD, re-confirmation need and durable docs facts. |
| `freshness.ts` | `humanThreadComments(forge, issue, login)` with timestamps, and the ship freshness check. |
| `pull-request.ts` | Reads the change's pull request from `PR:`, the pushed head (`refs/remotes/origin/<branch>`) and the merge state for the snapshot. |
| `feedback.ts` | Collects human feedback and failing checks, maps them to findings, filters already ingested keys. Pure over forge reads. |
| `feedback-poll.ts` | Single-flight poll: posts the feedback `review-run`, the `stale` comment and the phase move. |
| `ship-steps.ts` | Next steps of `ship` and `close` (pure). |
| `close.ts` | `change_close` steps: summary, initiative tick and close, issue close, events. |
| `records.ts` | The `ship` record kind (pull request, pushed head, confirmation items shown) and its queries. |
| `pr-body.ts` | The pull request title and body. Pure. |

Tools: `src/tools/docs-table.ts`, `change-ship.ts`, `change-push.ts`, `change-close.ts`, each only wiring `prepareWrite`, refusals and the module calls, like the existing unit tools. All four refuse in a child session.

### D2. The change diff

Ship checks use `git diff <M>..HEAD`, where `M = git merge-base HEAD origin/<integration>` after `git fetch origin <integration>`, falling back to `Base` when the fetch or the ref fails. Why not `Base`: after a merge from the integration branch, `Base..HEAD` contains other people's merged work, which would fail the Files check and pollute the durable docs facts. New `Git` methods: `mergeBase(a, b)`, `mergeTree(a, b)` (`git merge-tree --write-tree`, returning the tree or `conflict`), `treeOf(commit)`.

### D3. Reviewed HEAD and the clean-merge exception

`reviewedHead(state)` is the `head_sha` of the valid approved `review` gate result (`GateResult` gains `headSha`). HEAD is **reviewed** when it equals that SHA, or when every commit in `git rev-list --first-parent <reviewed>..HEAD` (the integration branch's own commits are not walked) is a merge commit whose first parent is the previous commit of that list (or the reviewed SHA), whose second parent is an ancestor of `origin/<integration>`, and whose tree equals `git merge-tree --write-tree <p1> <p2>` with no conflict. Tree equality proves both "no conflict" and "no hand edits in the merge commit". Requires git ≥ 2.38; older git makes the exception unavailable (strict equality only), reported in the refusal.

Both `change_ship` and `change_push` use this one definition, implemented as `isReviewed` in `src/ship/reviewed.ts`.

**Head-bound gates.** In `review` and `ship`, an approved gate result counts as superseded in `nextStep` (both its sentence and its waivers, through one predicate `approvedAtHead(state, phase)`) when HEAD is not reviewed against its `headSha` by the same `isReviewed` walk (flow-engine delta); `ChangeState.ship.gatesAtHead` carries that result, computed at refresh, so `nextStep` stays pure. `reviewedHead` reads the latest non-staled approval without head binding, so the walk still sees the old SHA, and `change_ship` accepts a ship approval at `s` on the same terms. Without it, a post-review commit sends the change to `review`, a clean round there finds the old review approval still valid, `gate()` advances to `ship`, and `ship` sends it back: a loop. With it, the review gate is requested again at the new HEAD, and the ship gate's re-confirmation (D5) compares at HEAD too. Alternative rejected: requiring a new review for every integration merge — correct but forces a full review round for a mechanical merge, which #9 explicitly exempts.

### D4. Ship freshness

`change_ship` refuses as stale when a human comment on the issue was created or edited after the forge `createdAt` of the valid ship `gate` comment (author/marker rule of D7), or the issue's gate digest differs from the `gate_digest` of the ship request record (`GateResult` gains `request`, the request id, so the tool finds that record in `state.marked`). The forge approval comment is read before the plugin writes the `gate` comment, so it is always older and never counts as new input. `src/ship/freshness.ts` provides `humanThreadComments(forge, issue, login)` returning comments with `createdAt`/`updatedAt`; `humanComments` of `source-kit.ts` cannot be reused because it needs a packet context and drops timestamps. On a stale refusal it writes a `stale` comment listing `ship`, so the existing gate logic asks for the ship gate again. This is the LS-07 freshness idea applied to the ship inputs (the issue and its comments); no packet exists at ship.

### D5. `change_ship` and `change_push`

`change_ship` order: refusals (D3, D4, Files check, open pull request, ship gate valid approval, clean tree, current branch = `Branch`, phase `ship`, `PR:` absent) → `guardedPush(origin, HEAD:refs/heads/<branch>)` → `createPullRequest({ head: branch, base: integration, title: change title, body })` → write `PR: #<n>` with a versioned body write (retry once on conflict by re-reading) → post an own `ship` record (marker kind `ship`, id `ship.<n>.<pushedHead>`) with the pull request, pushed head and the confirmation items the gate showed.

Idempotency: an open pull request whose head is the change branch, whose `author` (added to `PullRequest`) is the current login and whose body holds `Refs #<change>` is **adopted** (only `PR:` is written); any other open pull request for that head refuses. A push that succeeded before a failure is simply repeated (same refspec, fast-forward).

`change_push` order: poll feedback (D8) and refuse on poll failure or when it ingested anything → refusals (phase `ship`, `PR:` open and not merged, clean tree, current branch = `Branch`, pushed head present, HEAD reviewed per D3, Files check, HEAD descends from the pushed head so no force, `durable-docs` has no error) → **re-confirmation**: when `<pushedHead>..HEAD` touches `specs/`, or `durable-docs` has a confirmation item the latest `ship` record does not list, a valid approved ship gate with `head_sha` = HEAD is required → `guardedPush` → a new `ship` record. Why: a fix round after feedback can touch `constraints.md` or capability code; the human must see those at a gate, but a code-only fix needs no second human gate (the pull request is the review surface). When HEAD equals the pushed head it reports nothing to push.

The pull request body (`pr-body.ts`): the Proposal's first paragraph, the units with their status, the Durable docs table, the review result of the latest routed round, and the line `Refs #<change>`. Closing keywords (`close[sd]?`, `fix(e[sd])?`, `resolve[sd]?` followed by `#n` or `owner/repo#n`, case-insensitive) in the Proposal paragraph are rewritten to `Refs #n`.

### D6. `docs_table` and `durable-docs`

`docs_table { rows: [{ file, status: "updated" } | { file, status: "not needed", reason }] }` replaces the table, writing `| File | Status |` with `updated` or `not needed — <reason>`. It refuses outside `review` and `ship`, refuses an `updated` row whose file the change diff does not touch, and refuses `not needed` for a row a hard requirement covers. Allowed in `review` so the table can be written before the gate request.

The `durable-docs` rule (point `durable-docs`, config `decisions.durable-docs: { mode: rule }`, never asks) takes facts built by code: changed entries, `Capabilities`, each living spec's `capability` and `paths`, and the table rows. It returns `errors` and `confirm`:
- a `new` capability with no `updated` `specs/product.md` row → error;
- `specs/constraints.md` changed and no file added under `specs/decisions/` in the diff → error; with one, both files go to `confirm` as "constraints changed, decision `<file>`";
- code under a capability's `paths` changed and that capability's `specs/<cap>/spec.md` row is not `updated` → `confirm` item (before LS-10; LS-10 replaces this with the `behavior-change` record);
- an `updated` row not in the diff, a `not needed` row a hard rule covers, or a changed durable doc (`specs/**`) with no row → error.

The check `durable-docs` of the `ship` phase reports errors with severity `error` (not waivable) and confirm items as `warning`. `registerGatePayload("ship", …)` adds a "Needs your confirmation" section listing the confirm items, each `not needed` reason verbatim, and the decision files. The `ship` phase also lists output `issue#Durable docs` (missing → next step names `docs_table`); `PhaseOutput` and the pack schema's `OUTPUTS` gain it.

### D7. Whose voice counts

A forge comment, review or review comment is **own** when its author is the current `whoami()` login and `parseMarked(body)` finds a marker or the body holds LS-08's `livespec:finding` review-comment marker; every other one is a human voice. A human voice counts only when its author's permission is `write` or `admin`, read once per author per poll and failing closed (same as approver commands). It follows the same own-comment rule as `humanComments` in `src/subagents/source-kit.ts`.

### D8. Feedback as a pull-request round

The poll runs only when the change is in `ship`, `PR:` names an open, unmerged pull request, the tree is clean and no round is unrouted. Recovery (apply): an unrouted `source: pull-request` round whose `stale` comment or label move is missing is finished by the poll (stale comment posted once by id, then the idempotent move), so a crash between the posts cannot leave the change in `ship`. On GitHub `Review.updatedAt` is `submitted_at`, so an edited review body is not re-ingested (accepted). It collects:
- review comments with a path and line → `WARNING` `defect` at `path:line`, key `review-comment:<id>@<updatedAt>`;
- conversation comments and non-empty bodies of reviews that are not `approved` → `WARNING` `other` with scope `needs-decision`, location `pr#<n>`, key `comment:<id>@<updatedAt>` / `review:<id>@<updatedAt>`;
- checks of the pushed head (the pull request's head, which CI ran on) with state `failure` → `CRITICAL` `defect` at `check:<name>`, key `check:<pushedHead>:<name>`.

Keys already listed in any `review-run`'s `feedbackKeys` are dropped. When anything is left, the poll posts, in order: a `review-run` for round `n = roundNumber(marked)` with `head`, `source: pull-request`, `selected: []`, `tags: []`, `verify: {}`, `parentFindings` (the findings, evidence = the human text wrapped untrusted, fix = "address the pull request feedback") and `feedbackKeys`; a `stale` comment listing `review` and `ship` (through `staleComment(id, { reason, phases })`, exported from a new `src/interaction/stale.ts` onto which `complete-gate.ts`'s private writer is refactored; id `stale.feedback.<round>`); then `advancePhase(review)`. The next `spec_review` call finds the round at HEAD with nothing selected, posts the aggregate (parent findings skip the verifier as `skipped-parent`), and routes it. The findings keep the existing `from: parent` (so the verifier skip needs no change); the route stage does not post review comments for a round whose `review-run` has `source: pull-request`, because the human already wrote them there.

A `source: pull-request` `review-run` is never replaced when HEAD moves (review-phase "Review tool" changes): `round.ts` aggregates and routes it at its recorded head, so a commit made before `spec_review` runs cannot drop the feedback or its `feedbackKeys`.

Why a `review-run` and not a new record kind: the round state machine, aggregation, verification skip, routing, `review-clean`, the round cap and `review_rounds` all already derive from it. Cost: a feedback round records no `Verify` runs; the next code change starts a normal round that runs them.

`finding-scope` gains one step: a finding at `check:<name>` is `in-change` (after `question`, before `unit`); `RouteFacts` gains `check: boolean` computed from the location by code.

The poll posts the round even when the `review_rounds` cap blocks: the cap only refuses the *start* stage, and a feedback round has none, so `spec_review` aggregates and routes it and the cap then asks for `spec_stuck` — the human sees the feedback in the stuck report instead of it being dropped.

Single-flight per session like `pollApprovals`; called after `pollApprovals` at `session_start`, in `/livespec next`, and first in `change_push`. A failure is recorded with `session.record` and never fails the hook or command.

### D9. Pull request state and merge detection

The snapshot gains `pr?: { number, state, merged, mergedAt?, pushedHead? }`, read with `getPullRequest` from `PR:` and `git rev-parse refs/remotes/origin/<branch>`. Pull request reads are not cached, so in read-only mode `pr` is absent with a warning and every rule tolerates `pr === undefined`. `ChangeState.issue` gains `state`, so `issueOpen` is known in every phase. A new precedence rule 2, right after label repair, handles a merged or closed pull request in **any** phase before `close` while the change issue is open: a merge after an empty change diff (merge commit) would otherwise fail `durable-docs` at the checks rule, and a merge during a feedback fix round happens in `review` or `build`. The merge advance goes through `advancePhase(…, close, { merged: true })`, which allows the jump to the last phase only with that flag; the session's derived advance passes it from `state.pr.merged`. A pull request number that cannot be read leaves `pr` undefined and adds a warning; the ship step then says so.

**Refresh facts.** Git-dependent ship facts are computed once per refresh in `src/hooks/card-input.ts` through `src/ship/context.ts` (`shipContext(session)`: one fetch of the integration branch, the change diff, `isReviewed`, `needsShipGate`, `docsRowsNeeded`), with the fetch and the change diff memoized by HEAD for the session; `isReviewed` (for both gates), `needsShipGate` and `docsRowsNeeded` are recomputed on every refresh from local git reads, because they depend on gate SHAs, the pushed head and the latest `ship` record, which change without HEAD moving. `CheckContext` gains optional `ship?: ShipContext`, which the check runner fills from the same memo, so the `durable-docs` check does not fetch again. The integration branch comes from `integrationBranch(session.config.project, git)`.

**Push exec.** `Session` gains `exec: GitExec` (the one `createGit` already receives), passed to `guardedPush`, so tests record the push through the harness's exec.

### D10. Ship and close next steps

New precedence rules after the review rule and before the gate:
- **any phase before close** (rule 2): pull request merged → `advance: close`; closed unmerged → reopen it on the forge or `change_close --abandon <reason>`.
- **ship**: HEAD not reviewed → `advance: review` ("new commits need review"); no `PR:` → the gate (an approved gate now says "run `change_ship`"); HEAD equals the pushed head → wait for a human to merge #n; re-confirmation needed (D5) and no approved ship gate at HEAD → `shipStep` returns the gate decision itself (ready for the `ship` gate); otherwise `change_push`.
- **close**: issue open → `change_close`; issue closed → the flow has no further phase.

### D11. `change_close`

Refuses unless the phase is `close` and the pull request is merged (or, with `--abandon <reason>`, the pull request is closed unmerged, in any phase). Steps, each skipped when already done:
1. own `close-summary` comment id `close-summary.<change>`: pull request, merged at, units, durable docs rows, review rounds, or the abandon reason;
2. not abandoned and `Initiative: #N`: `tickChange` on the tracking issue (versioned body write); when every entry is now checked and the tracking issue is open, a `close-summary` comment id `close-summary.initiative` on it and close it;
3. close the change issue;
4. emit `livespec:change-closed { change, pr, initiative?, abandoned? }`, then `livespec:initiative-closed { initiative, changes }` when the tracking issue holds the own `close-summary.initiative` comment (so a retry after a partial close still emits it).

Events fire only from the call that closed the change issue (a rerun after the issue is closed emits nothing), so a listener sees each close once per session. Marker kinds `close-summary` (in `src/ship/close.ts`) and `ship` (in `src/ship/records.ts`) are registered. An abandoned change leaves its initiative entry unchecked; what the initiative does then is LS-09c's.

### D12. Guard spec and docs

`src/guard/push.ts`'s comment and the "Guarded push" requirement name `change_ship` and `change_push` as the only callers; a test scans `src/tools/` imports. `docs/architecture.md` gains Ship and Close sections; `docs/glossary.md` gains "Reviewed SHA" and keeps "Integration branch" (already present) with the merge-only rule.

## Risks / Trade-offs

- [A force-push or a push from another clone moves the remote branch] → `change_push` refuses when HEAD does not descend from the pushed head; the human resolves it.
- [Feedback arrives during a fix round] → the poll ingests only in `ship`; `change_push` polls first, so nothing is pushed over unseen feedback.
- [A file outside `specs/` that is a durable doc for the project, such as `docs/architecture.md`] → it must be in some unit's `Files`, as #9 requires; the plan reviewer catches a unit that forgets it.
- [Bot accounts with write access (CI bots) commenting] → they count as human voices; a failing check is the intended CI channel. Accepted for v1, documented.
- [`git merge-tree --write-tree` missing on old git] → the clean-merge exception is off and the refusal says why.
- [Event listeners in another session miss an event] → events are in-process only; LS-10 must also derive from closed issues. Documented.
- [Two sessions ship the same change] → adoption only for an own `Refs #<change>` pull request; anything else refuses.
