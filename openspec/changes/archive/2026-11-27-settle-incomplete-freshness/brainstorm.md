## Design Summary

Fixes [#69](https://github.com/ttdua/pi-livespec/issues/69): the `incomplete` comment and the `Incomplete` line can list items that stopped being true, as on naicoi92/iroh-tunnel#268.

**Root cause (confirmed from the #268 pi session log on 1g-herdr).** No `settle:` warning was recorded in the session, so no fail-open path ran. The sequence was:

- 15:30:43, second settle of a prompt: the comment was written as `[U2 is started]`.
- 15:31: one user prompt started a single long run. U2 got its receipt at 16:43, and U3 and U4 were started.
- 16:49:40, first settle of that prompt: a continuation was requested for `U3 is started, U4 is started`, and nothing was written.
- The continuation then ran unbroken through review, stuck S2 and a rebuild, past 01:14 the next day. No settle followed.
- The phase card printed `Incomplete: U2 is started` 68 times during that window.

Two gaps combine:

1. The settle that asks for a continuation never rewrites the comment, even when the items differ from the recorded ones.
2. The phase card and the step views show the recorded items as fact, and nothing reconciles them with the current state until the next settle, which may be hours away.

Fixing only the first gap would still let the card contradict `spec_status` between settles. So the change covers both.

**Existing requirements involved** (`openspec/specs/settle-continuation/spec.md`):

- *Incomplete marker*: writing happens only "at the settle after the continuation", clearing only when no unfinished item holds, and "the phase card SHALL show" the items of the latest comment. **This change alters that requirement**:
  - a settle that requests a continuation also rewrites a comment whose items differ;
  - the shown items are filtered against the current state.
- *One continuation*: unchanged. Still one continuation per prompt.
- *Settle conditions*: unchanged. The items and when settle applies stay the same.

**Goals**

- The comment follows the current items at every completed settle where it already exists and differs. The first `incomplete` comment is still created only after the continuation.
- The `Incomplete` line never lists a `<unit> is started` item when that unit is no longer started in the current state, for example because it has a receipt.
- When the hook cannot tell what is unfinished (forge unavailable, read-only or stale state), or a write is refused, the user can see it. The card marks the line `Incomplete (may be stale)` instead of stating it as fact.

**Non-goals**

- No change to how items are computed, to the one-continuation rule, or to which phases settle applies to.
- Evidence tools (`unit_start`, `unit_finish`) do not write the comment.
- No persistence of `session.record` warnings.

**Anti-goals**

- A card that drops a still-true item, for example a dirty tree or a registered condition the state cannot re-check. Those keep showing as recorded.
- Extra forge writes when nothing changed. A settle whose items equal the recorded ones writes nothing.

## Alternatives Considered

### Alternative A: Rewrite on change + reconcile shown items with state
- **Approach**: Every completed settle rewrites an existing comment whose items differ from the current ones, including the settle that asks for a continuation. The shown `Incomplete` items drop the started-unit items that the current state contradicts. An unknown state or a refused write is marked on the card and surfaced to the user.
- **Pros**: Keeps the marker's meaning ("the last stop left this unfinished"). Fixes both gaps. Stays inside the settle seam and the step/card rendering.
- **Cons**: A little reconciliation logic in the step view. A few more forge writes on settles where the items changed.

### Alternative B: Derive the `Incomplete` line from live `settleItems`
- **Approach**: The card computes the line from the current state and ignores the comment.
- **Pros**: Always current.
- **Cons**: While U3 is being built, the card permanently shows `U3 is started`, which duplicates `Started units` and loses the meaning of "the previous stop was unfinished". A later session no longer sees why the last run stopped.
- **Why not chosen**: Removes the marker's purpose instead of fixing its freshness.

### Alternative C: Evidence tools rewrite the comment
- **Approach**: `unit_start`, `unit_finish` and `lane_merge` rewrite the comment whenever the started set changes.
- **Pros**: The comment is fresh between settles.
- **Cons**: A forge write on every evidence change. It couples settle bookkeeping to the evidence tools and moves it out of the settle seam. A dirty tree or a registered condition still only refreshes at settle.
- **Why not chosen**: Wider coupling and more writes than A, while still needing A's reconciliation for the non-unit items.

## Agreed Approach

Alternative A, chosen by the user. It fixes the write gap at the seam that owns the comment and the display gap where the items are shown, without changing what counts as unfinished.

## Key Decisions

- Only started-unit items are reconciled with the state. Other recorded items (dirty tree, registered conditions) are shown as recorded, because the state at render time is not the state the condition saw.
- The `Incomplete` line is reconciled in the shared step data, so the phase card, `spec_status` and `spec_next` agree.
- The first creation of the comment still happens only at the settle after the continuation. Only an existing comment is rewritten at an earlier settle.
- When the clear or rewrite is skipped because the state is unknown, or a write is refused, the card says the line may be stale and the user is told. A recorded warning alone is not enough, because it is invisible.
- Repro test: U2 started → receipt → U3/U4 started and finished → review, with the card checked mid-run and after the next settle.

## Open Questions

None.
