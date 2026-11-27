## Context

`src/hooks/settle.ts` (`beforeSettle`) owns the `incomplete` comment. Today it writes in two places only:
- in the `items.length === 0` branch, which clears the comment when it lists items;
- in the `asked` branch, at the settle after the continuation.

The continuation branch never writes. `src/engine/snapshot.ts` (`incompleteItems`) exposes the latest comment's items as `state.incomplete`. `nextStep` (`src/engine/next-step.ts`) copies them into `step.incomplete`, which `src/hooks/phase-card.ts` and `src/tools/format-step.ts` render as `Incomplete: …`. Nothing between two settles reconciles them with the current state.

A write error is thrown out of `beforeSettle` and only `session.record`ed by the hook wrapper. A refusal from `requireWritable` is only recorded too. Neither reaches the user.

## Goals / Non-Goals

**Goals:**
- Rewrite an existing comment whose items differ, at every completed settle.
- Reconcile started-unit items with the state in `nextStep`.
- Make an update that was skipped or refused visible.

**Non-Goals:**
- Changing `settleItems`, the one-continuation rule, or which phases settle applies to.
- Writing from evidence tools.
- Persisting session warnings.

## Decisions

### D1: The write decision compares the current items with the recorded items

`beforeSettle` compares the computed `items` with `card.state.incomplete`, the raw recorded items, element by element and in order:

| Settle | Recorded | Current | Write |
|---|---|---|---|
| any | non-empty | empty | clear (`[]`) |
| continuation requested (`asked` unset) | non-empty | non-empty, different | rewrite with current items |
| continuation requested | empty or absent | non-empty | none: the first comment waits for the continuation |
| after the continuation (`asked` set) | any | non-empty, different | create or rewrite |
| any | equal | equal | none |

Equal items no longer refresh `at` and `head_sha`: an anti-goal of the brainstorm is to avoid writes when nothing changed.

*Alternative:* always rewrite at the continuation settle. Rejected: a comment that was cleared or never written would gain items before the agent had its one chance to finish, which changes the marker's meaning.

### D2: A write failure on the continuation settle does not cancel the continuation

On the continuation settle, the rewrite runs inside its own `try`. On failure the hook records the failure, notifies the user (D4), and still returns the continuation. Otherwise the outer catch would swallow the continuation.

### D3: The item format is shared, and reconciliation lives in `nextStep`

A small engine module (`src/engine/incomplete-items.ts`) owns `startedItem(id)` (`"<id> is started"`) and `reconcileIncomplete(items, started)`. `reconcileIncomplete` drops an item that parses as a started-unit item whose unit is not in `state.evidence.started`, and keeps every other item as recorded. `settleItems` builds its started items with `startedItem`. `nextStep` sets `step.incomplete = reconcileIncomplete(state.incomplete, state.evidence.started)`. The module stays pure, so `nextStep` stays pure.

The module sits in the engine because `next-step.ts` must not import from `hooks/`. Because the format has a single owner, the parser cannot drift from the writer.

*Alternative:* filter in the renderers. Rejected: the card and the step text of `spec_next` and `/livespec next` would each need it, and `NextStep` would still carry stale data to tool `details`.

### D4: Skipped and refused updates are notified, and the line is labelled when the state is unknown

The settle hook has `ctx`. A guarded `ctx.ui.notify(message, "warning")` helper (`try`/`catch`, like `session.ts`'s `safeNotify`) is called in addition to `session.record` in three cases:
- **Unknown state:** the card is a change whose state is read-only or stale and whose recorded items (`state.incomplete`) are non-empty, so a needed clear or rewrite may have been skipped. Settle items are not computed from an unknown state. A `forge-unavailable` card has no change state, so it is only recorded, as today.
- **A refused write** (`requireWritable` not ok).
- **A thrown write error.**

The message names the change and the reason, for example `livespec: the incomplete comment of #268 was not updated: the forge is in read-only mode`.

The card and `formatStep` render the line as `Incomplete (may be stale): …` when `state.stale || state.readOnly`, otherwise as `Incomplete: …`. The label is chosen at render time from the state the renderers already receive. `NextStep` gets no new field.

## Risks / Trade-offs

- [A recorded dirty-tree or condition item can still be out of date between settles] → It is kept on purpose, because the render-time state is not what the condition saw. The next settle rewrites it under D1.
- [More forge writes on settles where the items changed] → Bounded by D1: equal items never write.
- [A notification on every settle while the forge stays offline] → Only when a write may be needed (D4). Repeated notices while the forge stays down are accepted, because the user should know.
- [With a truly unreachable forge, `whoami` fails, the login is unknown and own comments are not read (`snapshot.ts` `readCommentFacts`), so `state.incomplete` is empty and D4's unknown-state notice does not fire] → Accepted: the card already states `Stale:`/`Read-only:` in that case, and an empty `Incomplete` line is not stated as fact. The notice fires when the state is read-only or stale but own comments were still read (for example read-only mode with a cached login). Reading items from the comments cache while the login is unknown is out of scope.
- [Item text from another version of livespec does not parse as a started-unit item] → `reconcileIncomplete` keeps it as recorded, so the worst case is today's behaviour.

## Migration Plan

None. Existing comments keep their format. The first settle after the upgrade applies D1.

## Open Questions

None.
