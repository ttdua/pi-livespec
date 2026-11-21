## Design Summary

**Intent.** Finish the life of a change safely. Today a change ends at an approved `ship` gate with nothing after it: the agent cannot push (the guard blocks `git push`, and `guardedPush` has no caller), no pull request is opened by a tool, pull request feedback never reaches the flow, and nothing closes the issue. This change (LS-09a, issue #32, part 1 of 3 of LS-09 #9) adds the ship, pull request feedback and close parts. The small-fix lane and initiatives/discovered dependencies are the two later parts and are out of scope here.

**Why.** Two failures from #9: shipping too early (push or pull request before review) and shipping too wide (unrelated work in the pull request). The issue must stay the source of truth until a human has merged.

**Goals**
- `docs_table` writes the change issue's `## Durable docs` table; an `updated` row must name a file changed in `git diff <Base>..HEAD`.
- Rule `durable-docs`, registered with `registerRule` and as a check of the `ship` phase, with the three hard requirements of #9 (capability code → spec row `updated`; a `new` capability → `product.md` `updated`; `specs/constraints.md` changed → a new `specs/decisions/` file in the same diff, shown at the ship gate for explicit approval).
- `change_ship`: refuses unless the reviewed SHA is HEAD (except a conflict-free merge commit from the integration branch), sources are fresh (LS-07), every changed file is in some unit's `Files` or under `specs/`, no other pull request is open for the change, and the ship gate is approved. It pushes through `guardedPush`, opens exactly one pull request whose body says `Refs #<change>`, and records `PR: #<n>` in the ownership lines.
- `change_push`: pushes new commits only when the review gate passed again for the new HEAD.
- Pull request feedback, polled at `session_start`, on `/livespec next` and before `change_push`: a human review comment with `path:line` → `WARNING` at that location; a human comment without a location → `needs-decision` (a `Q<n>`); a failing CI check → `CRITICAL` with the check name as location, routed `in-change`. All go through `routeFinding` and count in `review_rounds`.
- Merge detection with `getPullRequest`, and `change_close`: a `close-summary` comment, the issue closed, `tickChange` in the initiative when there is one, event `livespec:change-closed`; when the initiative's last change closes, the tracking issue is closed with a summary and `livespec:initiative-closed` is emitted.
- Marker kind `close-summary`. The `command-guards` "Guarded push" requirement changes: the ship tools become the only callers.

**Non-goals**
- Small-fix lane, `lane` rule, `fix_*` tools (LS-09b).
- Initiative proposing, `change_split`, `size-limits`, park/resume, `Depends` readiness (LS-09c).
- Define-time durable docs checks, the `behavior-change` record and drift audit (LS-10).
- Merging the pull request. A human always merges, on the forge.

**Anti-goals** (a failure even if it technically works)
- Any path that pushes or opens a pull request without the checks above, including a tool parameter, command or environment variable the agent controls.
- A second pull request for the same change.
- The issue closing through `Closes #n` on merge, or before a human merged.
- The same pull request comment or failing check producing a new finding on every poll.

## Alternatives Considered

### Alternative A: Feedback re-enters the existing review loop (chosen)
- **Approach**: a poll that sees new pull request feedback records it as a new aggregate round at the current HEAD, routed with `routeFinding`, and marks `review` and `ship` stale. The change then follows the existing review next steps (back to `build` for a `unit` route, `unit_amend --add` for `in-change`, a question for `needs-decision`), passes the review gate again at the new HEAD, and only then can `change_push` push.
- **Pros**: reuses all of LS-08 (aggregate, routing, review-clean, round cap); `review_rounds` counts pull request rounds for free; one definition of "reviewed".
- **Cons**: the phase label moves back from `ship` and forward again after each fix round.
- **Why chosen**: the user agreed; it has no duplicated loop.

### Alternative B: A sub-loop inside `ship`
- **Approach**: the change stays in `ship`; amend, build and review happen as a nested loop in that phase.
- **Pros**: the phase label never moves back.
- **Cons**: duplicates the build/review next-step logic for `ship`; two meanings of "reviewed".
- **Why not chosen**: more code, and it diverges from LS-08's single review definition.

### Alternative C: Feedback as plain questions only
- **Approach**: every pull request comment and failing check becomes a `Q<n>` for the human.
- **Pros**: simplest.
- **Cons**: contradicts #9's mapping (`WARNING`, `CRITICAL`, `in-change`); a failing CI check would wait for a human instead of being fixed.
- **Why not chosen**: does not meet the issue's Done when.

## Agreed Approach

Alternative A. Pull request feedback is review input: it lands as a routed aggregate round and sends the change back through the same review loop, so `change_push` and `change_ship` share one rule — the pushed HEAD is a reviewed HEAD.

## Key Decisions

- **Feedback re-enters review** (user decision): new pull request feedback becomes an aggregate round at HEAD, routed by `routeFinding`, with `review` and `ship` marked stale, and the change returns through the normal review next steps.
- **Merge moves the phase to `close`** (my call, user agreed): when `getPullRequest` reports the pull request merged, at `session_start` or `/livespec next`, the label moves `ship → close` and the next step names `change_close`. `change_close` refuses until the pull request is merged.
- **Capability code without a spec row before LS-10** (my call, user agreed): it appears in the ship gate payload as an item needing confirmation; approving the ship gate is the human's confirmation that behavior did not change. It does not block the gate by itself.
- **`change_push` after feedback** (my call): after a fix round the review gate must pass at the new HEAD; the ship gate is not asked again for a push to an existing pull request. The pull request itself is the human's review surface from then on.
- **Only human voices count** (my call, following the existing `humanComments` and forge-markers rule): a comment is the plugin's own when its author is the current login **and** it carries a livespec marker (this covers LS-08's finding review comments); every other comment is a human voice, so a user sharing the account with the plugin is still heard. Only authors with `write` or `admin` permission count, fail-closed, as for approver commands.
- **Ingest once** (my call): a comment is ingested once per `id@version` (an edited comment is new feedback); a failing check once per check name and HEAD. A comment that was already ingested never starts a new round after a push.
- **Poll failure** (my call): at `session_start` and `/livespec next` a failed poll is recorded and does not fail the hook or command; before `change_push` a failed poll makes `change_push` refuse, since unseen feedback could be pushed over.
- **`change_ship` runs once** (my call): when a pull request already exists for the change, `change_ship` refuses and names `change_push`. In `ship` with a pull request open, once the review gate passes at the new HEAD the next step is `change_push`; the ship gate is not asked again.
- **Pull request questions** (my call): a `needs-decision` comment becomes a `Q<n>` answered through the existing question channel (in session or `/livespec answer` on the forge). Its `question` route blocks `review-clean` until answered, so `change_push` is blocked too.
- **Closed without merge** (user decision): the change stays in `ship`; the next step says the pull request was closed unmerged and asks the human to reopen it on the forge (livespec continues with that same pull request) or to abandon the change with `change_close --abandon <reason>`, which posts the `close-summary` with the reason, closes the issue without ticking the initiative, and emits `livespec:change-closed` marked abandoned. A second pull request is never opened.
- **Pull request body references, never closes**: `Refs #<change>`, so only `change_close` closes the issue.
- **Docs**: `docs/architecture.md` (ship, close) and `docs/glossary.md` (integration branch) are updated.

## Open Questions

- None blocking. Technical choices (how a conflict-free merge commit is recognised, how ingested feedback is remembered, the poll's place among existing polls) are left to design.
