## Design Summary

**Intent.** Handle work bigger than one change, and a prerequisite found mid-build, without losing work or ordering. This change (LS-09c, issue #34, part 3 of 3 of LS-09 #9) adds initiatives, `Depends` readiness, `size-limits`, `change_split`, the `new-dependency` gate, park and resume. It builds on LS-09a (#32: `guardedPush`, the change diff, `change_close` ticking initiatives) and LS-09b (#33: small-fix lane). The full behavior text is #9 **Initiatives** and **Discovered dependencies**; #34 owns those sections.

**Why.** From #9: large work needs splitting into changes with a clear order, and a missing prerequisite found during build needs a safe path that loses no work. Without this, the agent either packs unrelated work into one pull request or calls `spec_stuck` and abandons in-progress lanes.

**Existing requirements involved**
- `change-issue-format` "Initiative body parsing" and `tickChange`: the initiative body format (`Goal`, `Capabilities`, `## Changes` with `Depends`) already parses and round-trips; this change writes such bodies.
- `forge-markers` label constants: `livespec:initiative` and `livespec:parked` already exist; marker kind `parked` is added here.
- `phase-gates` "Gate tool" and "Waivable checks": named gates with options, `source: human`, and waivable checks (its scenarios already use `new-dependency` and `size-limits` as test names). Reused unchanged.
- `flow-engine` "Next step precedence" and "Loop counters": already honor a waived `size-limits` at the plan gate and report `discovered_deps` against the pack cap (`loops.discovered_deps: 2`, `limits: { max_units: 8, max_capabilities: 3 }` are in the default pack).
- `change-tools` "Change new tool": **this change alters it**: `initiative_propose` approval creates change issues that start with `Initiative: #T`, a short Proposal and `Depends`, instead of `Depends: —` and empty sections.
- `change-tools` "Change start refusals": **this change alters it**: `change_start` also refuses while any `Depends` has not merged.
- `subagent-dispatch` "Result handling": today `BLOCKED` with `missing-prerequisite` goes to `spec_stuck` "until a dependency gate exists". **This change alters it**: it opens the `new-dependency` gate instead (and `spec_stuck` only when `discovered_deps` is exceeded).
- `command-guards` "Guarded push": today only `change_ship`, `change_push` and `fix_ship` may call `guardedPush`. **This change alters it**: park becomes a fourth caller, pushing only `livespec/<change>--wip-<unit>` branches.
- `parallel-lanes` "Lane worktree": park reads the open `lane` records to find every in-progress unit's worktree; the lane is closed after its wip commit is pushed.
- `context-injection` "Phase card content": the card gains initiative progress, ready changes, and the parked state.
- `change-close`: unchanged; it already ticks and closes initiatives.

**Goals**
- Rule `split` and `initiative_propose` at shape: the agent lists changes (name, short Proposal, `Depends` by name) and the `initiative` gate (registered with `registerGate`, decided by a human, recorded `source: human`) approves them. On approval the tool creates the tracking issue (label `livespec:initiative`) and every other change issue at once. The list in the tracking issue body is the only source of truth.
- Readiness: a change is ready when every `Depends` has merged. `change_start` refuses otherwise. A `Depends` cycle is rejected wherever `Depends` are written. The phase card shows initiative progress and ready changes; a human runs each `change_start`.
- Parallel changes: after a sibling merges, the next step says to merge the integration branch in and re-run every finished unit's `Verify`; a conflicted merge sends the change back to review (already true through the reviewed-SHA rule). A forge check warns when two open changes modify the same capability.
- `size-limits`: a waivable plan check over `limits.max_units` and `limits.max_capabilities`.
- `change_split #N --units … --into <name>` with #9's `Depends` rules.
- Discovered dependencies: the `new-dependency` gate with options A to D (A default), park (wip branches pushed through `guardedPush`, label `livespec:parked`, marker kind `parked`), `change_resume #N`, and the `discovered_deps` counter calling `spec_stuck` when exceeded.
- Docs: `docs/architecture.md` (initiatives).

**Non-goals**
- Sub-issue or forge-dependency mirroring (v1 keeps the body list as the only truth).
- Automatic `change_start` or `change_resume`: a human runs each.
- The `behavior-change` record and drift audit (LS-10).
- Auto-merging the integration branch: the agent merges with plain `git merge`; livespec only checks and guides.

**Anti-goals** (failures even if it technically works)
- Change B starting before change A merged, by any path the agent controls.
- A plan over the limits approved with no split and no human waiver.
- Losing uncommitted work of any in-progress unit or lane when parking.
- A `Depends` cycle accepted into an initiative or change body.
- Park pushing anything other than its own wip branches.

## Alternatives Considered

### Alternative A: The shaping change becomes the first entry of the initiative (chosen)
- **Approach**: `initiative_propose` is called from a change in `shape`. On approval, that issue stays and gets `Initiative: #T`, its rewritten Proposal and `Depends`; the tool creates the tracking issue and only the other changes.
- **Pros**: no orphan issue; pending requests and shape history stay on the issue; one fewer issue to create.
- **Cons**: the current issue's body is rewritten as part of approval, so completion has one more idempotent step.
- **Why chosen**: the user agreed; it keeps history and avoids a closed duplicate.

### Alternative B: Close the shaping change and create all changes
- **Approach**: close the current issue with "split into initiative #T" and create every listed change.
- **Pros**: uniform creation path.
- **Cons**: loses shape history on the new issues; one extra closed issue per initiative.
- **Why not chosen**: discards context for no gain.

### Alternative C: The shaping change becomes the tracking issue
- **Approach**: relabel the current issue to `livespec:initiative` and rewrite it into the initiative format.
- **Pros**: no new tracking issue.
- **Cons**: a change body and an initiative body have different parsers and labels; converting in place is fragile and breaks the existing change-issue invariants.
- **Why not chosen**: highest risk of corrupt state.

## Agreed Approach

Alternative A, with the rest of the behavior as #9 and #34 describe it: the initiative body is the only source of truth for change order; readiness and cycles are computed from it plus each change's own `Depends`; park keeps every in-progress unit's work on a pushed wip branch, and resume continues from it after the prerequisite merges.

## Key Decisions

- **Shaping change becomes the first entry** (user decision, Alternative A).
- **Defaults** (agreed in #34): a human runs each `change_start` and `change_resume`; option A is the default of `new-dependency`; `discovered_deps: 2`; `max_units: 8`, `max_capabilities: 3`.
- **"Merged" means** (my call, revised after the brainstorm gate): the dependency's issue is closed and the forge reports the pull request its `PR` line names as merged. An own `close-summary` was the first idea, but only the current account's markers count, so a change closed by another account would never become ready. An abandoned dependency never counts as merged; its dependents stay not ready until an initiative amendment removes it from their `Depends`.
- **Cycle rejection** (my call): checked over the initiative's `## Changes` list plus each listed change's `Depends`, at `initiative_propose`, at the gate completion, at `change_split`, and when option A adds `Depends: #new`. A self-dependency is a cycle.
- **`initiative_propose` from a change already in an initiative** (my call, revised after the brainstorm gate): it amends that initiative under a light `initiative` gate that shows only the affected entries: a new change entry, the Proposal of a change not yet planned, or the `Depends` of a change not yet started. Without this there is no tool for plans that change midway.
- **Option A with no initiative** (my call): approving `new-dependency` with option A also approves the initiative covering both changes, so the human decides once; the gate payload shows the initiative that will be created.
- **Option D** needs a drop path (my call): `change_close --abandon <reason>` also accepts a change with no pull request when its latest valid `new-dependency` gate chose D with action `drop`.
- **Same-capability warning** (my call): a warning-level check, never blocking, comparing `Capabilities` (new and modified) of open changes that have a `Branch`.
- **`discovered_deps` counts** (my call): one per approved `new-dependency` gate with option A, B or C on the change; option D does not count. Reaching past the cap calls for `spec_stuck`, and the next step names it.
- **Park scope** (my call, revised after the brainstorm gate): park is its own parent tool, `change_park`, which the next step names once option A is approved. It is not a completion effect, because a forge answer may be completed by a session on another machine or branch, and park needs the local worktrees. A unit with no commits and no uncommitted work since its start gets no wip branch. Attempt counters of parked units do not increase.
- **Option D** (my call): "back to shape" posts a `stale` comment listing `shape` and every later phase (not a counted iteration) and moves the phase back to `shape`; "drop" is `change_close --abandon <reason>`, run by the agent after the gate records it.

## Open Questions

- None blocking. Where the new tools live, how the initiative gate's completion stays idempotent across issue creations, and how park stages and commits lane worktrees are left to design.
