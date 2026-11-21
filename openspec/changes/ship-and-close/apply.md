# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `ship-and-close`
**Iteration**: `1`
**Applied at**: `2026-11-21 23:50`
**Executor**: `subagent-driven-development` (implementer: `superspec.implementer`; task and whole-branch reviewer: `superspec.task-reviewer`)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.ship-and-close`
- **Worktree branch**: `ship-and-close`
- **Feature branch**: `LS-09a`
- **Base branch**: `main`

---

## Commits

- **Range**: `0849377..<receipt commit>` (implementation through `d52f5a5`; this receipt is the last commit)
- **Count**: `43`

---

## Tasks

- **Completed**: `32 of 32` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

---

## Contract deviations

- `shipStale`: became `(state, gateComment, humans)`, then `shipStaleness` / `writerVoices(…, gateComment)` — the one-list form could not tell the own gate comment from own ship/stale comments; freshness counts only writer voices newer than the ship gate (final review, spec "Ship tool" wording updated).
- `pullRequestBody`: closing keywords are rewritten across the whole composed body, including comma/`and` lists (the plan's `$3` named the wrong group).
- `shipContext` / `shipFor` / `shipStateFor`: input narrowed to `Pick<ChangeState, …>` with optional lock/pr/marked; `shipFor` fails closed in `ship`; `ChangeState.ship` also carries `durableFacts`; `SHIP_PHASE` in `src/ship/phase.ts`.
- `approvedAtHead` / `reviewedHead`: narrowed inputs (`lock`, `ship`); `shipStateFor` replaces `shipFacts`.
- `readPullRequest`: optional `readOnly` parameter; pushed head read separately; only forge/git errors become warnings.
- `staleShipId(staleness, gateCommentId)`: ids `stale.ship.<gate>.<commentId>-<updatedAt>` / `stale.ship.<gate>.digest.<digest>` (marker id charset; gate-scoped to avoid a re-gate loop).
- In-session ship approvals: the gate digest is read from the `answer` record's embedded request.
- `applyRoutes`: optional `{ postReviewComments }`; `mergeFindings`: optional `{ keepParents }` (feedback rounds only); aggregate keeps `check:<name>` locations unnormalized.
- Feedback poll: finishes a posted-but-unmoved feedback round (spec "Feedback poll" and design D8 updated); a refused move returns `failed`; `Session.feedbackPollInFlight`; human text capped per item.
- `CheckContext.ship` may be `{ refused }`, `CheckContext.phase` and `CompletionCtx.shipFor` added (durable-docs fails closed at answer validation).
- New internal modules: `src/engine/gate-decision.ts` (shared gate sentence), `src/ship/writers.ts`, `src/ship/versioned-write.ts`, `src/ship/ship-refusals.ts`, `src/ship/ship-writes.ts`.
- Spec/artifact rulings recorded during apply: decision-only diffs need no Durable docs row (ship-phase "Durable docs output"); an Initiative line naming an initiative that does not list the change refuses before any write.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | sequential | 0849377..9198bb9 | approved | — |
| 2 | sequential | 1fa3206..687869a | approved after 1 fix round | — |
| 3 | sequential | db2458e..baf09ce | approved after 1 fix round | — |
| 4 | sequential | 003d561..b9a2449 | approved | — |
| 5 | sequential | b3d9b1f..74b09c4 | approved | — |
| 6 | sequential | 19f4f4f..ea2e227 | approved | — |
| 7 | sequential | aacd1cf..d6b3651 | approved after 1 fix round | — |
| 8 | sequential | b98a600..5dd4cd3 | approved | — |
| 9 | sequential | 654a4e4..56ac752 | approved after 1 fix round | — |
| 10 | sequential | dd01602..8d6f867 | approved after 2 fix rounds | — |
| 11 | sequential | 04f5bef..fab83d3 | approved with 1 ruling | — |
| final | sequential | 1c4c8c5..d52f5a5 | whole-branch review approved after fix wave + residual fix | — |

---

## Next step

Run `/opsx-verify`.
