## Why

A livespec change today ends at an approved `ship` gate with nothing after it: the guard blocks every `git push`, `guardedPush` has no caller, no tool opens a pull request, pull request comments and CI failures never reach the flow, and nothing closes the issue. Agents therefore either stop or work around the flow, which is exactly the "shipping too early or too wide" failure LS-09 (#9) targets. LS-09a (#32) adds the ship, pull request feedback and close parts, so the only way out of a change is one reviewed pull request that a human merges.

## What Changes

- **`docs_table`**: writes the change issue's `## Durable docs` table (`updated` or `not needed — <reason>` per row); an `updated` row must name a file changed in the change diff. The default pack's `ship` phase gains the output `issue#Durable docs`.
- **Rule `durable-docs`** (`registerRule`) and check `durable-docs` of the `ship` phase: a `new` capability needs `product.md` `updated`; a changed `specs/constraints.md` needs a new `specs/decisions/` file in the same diff, shown at the ship gate; code under a capability's `paths` without an `updated` spec row is shown at the ship gate for the human to confirm (before LS-10).
- **`change_ship`**: refuses unless the reviewed SHA is HEAD (or HEAD only adds conflict-free merges from the integration branch), no human input arrived since the ship gate, every changed file is in a unit's `Files` or under `specs/`, no other pull request is open, and the ship gate is approved. It pushes through `guardedPush`, opens exactly one pull request with `Refs #<change>`, and records `PR: #<n>`.
- **`change_push`**: pushes new commits to the open pull request only when the review gate passed at the new HEAD.
- **Pull request feedback**: polled at `session_start`, on `/livespec next` and before `change_push` while the change is in `ship`. Human review comments with `path:line` become `WARNING`s, comments without a location `needs-decision` questions, failing CI checks `CRITICAL` findings routed `in-change`. New feedback forms one routed aggregate round (counted in `review_rounds`) and sends the change back to `review`.
- **Merge detection and `change_close`**: a merged pull request moves the change to `close` from any phase; `change_close` posts a `close-summary`, ticks the initiative, closes the tracking issue when it was the last change, closes the issue and emits `livespec:change-closed` / `livespec:initiative-closed`. A pull request closed without merge keeps the change where it is until a human reopens it or runs `change_close --abandon <reason>`.

**Guarded push**
- From: no tool may call `guardedPush`.
- To: only `change_ship` and `change_push` call it, after their refusal checks.
- Reason: pushing is now a livespec tool's job.
- Impact: non-breaking; the guard still blocks every `git push` the agent runs.

**Ship next steps**
- From: an approved ship gate says "ready to ship" and `close` has no further step.
- To: `ship` names `docs_table`, `change_ship`, `change_push` or waiting for the merge; `close` names `change_close`.
- Reason: the flow must lead to one pull request and a closed issue.
- Impact: non-breaking for earlier phases.

## Capabilities

### New Capabilities
- `ship-phase`: `docs_table`, the `durable-docs` rule and check, `change_ship`, `change_push`, the reviewed-SHA and merge exception, the ship records, and the ship phase's next steps.
- `pull-request-feedback`: polling, which pull request comments and checks count, the mapping to findings, ingest-once, the feedback round and the return to `review`.
- `change-close`: merge detection, a pull request closed without merge, `change_close` and `--abandon`, the `close-summary` marker kind, initiative ticking and closing, and the two events.

### Modified Capabilities
- `command-guards`: "Guarded push" — the ship tools become the only callers.
- `finding-routing`: "Finding scope rule" gains a failing CI check → `in-change`; "Pull request review comments" does not re-post the findings of a pull request feedback round.
- `flow-engine`: "Change state from issue and git" gains the pull request state; "Next step precedence" gains the pull request outcome, ship and close steps and changes the last-phase and ship scenarios; "Advance phase" allows moving to the last phase when the pull request is merged.
- `phase-gates`: "Waivable checks" and "Gate outcomes" — an approved ship gate now says to run `change_ship`.
- `flow-pack`: "Default flow pack" — the `ship` phase gains output `issue#Durable docs` and check `durable-docs`, and decisions gain `durable-docs`; "Pack schema rules" accepts the output `issue#Durable docs`.
- `review-phase`: "Review tool" never replaces a pull request feedback round on a new HEAD; "Review next steps" — an `in-change` CI finding names its check instead of a file.

## Impact

- **New code:** `src/ship/` (change diff, reviewed-SHA check, durable docs rule, ship records, feedback ingest, merge detection, close), tools `docs-table.ts`, `change-ship.ts`, `change-push.ts`, `change-close.ts`.
- **Changed code:** `src/engine/next-step.ts`, `snapshot.ts`, `state-types.ts`, `git.ts` (merge-base, merge-tree, tree of a commit); `src/forge/types.ts`, `github.ts`, `gitea.ts` (`id` and `updatedAt` on review comments and reviews); `src/review/route.ts`, `effects.ts`, `next.ts`; `src/hooks/session.ts`, `src/commands/next.ts`; `src/packs/agent-skills.yaml` and its fixture; `src/guard/push.ts` comment.
- **Runtime:** `git merge-tree --write-tree` needs git 2.38 or later.
- **Docs:** `docs/architecture.md` (ship, pull request feedback, close), `docs/glossary.md` (integration branch, reviewed SHA).
