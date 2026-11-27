## Why

The `incomplete` comment and the `Incomplete` line can list items that stopped being true. On naicoi92/iroh-tunnel#268 the card showed `U2 is started` for eight hours after U2's receipt, and a stuck report cited the conflict with `spec_status`. The settle that requests a continuation never rewrites the comment, and nothing reconciles the shown items with the current state between settles. Stale items mislead the agent and the human about what is unfinished.

## What Changes

**Rewriting the `incomplete` comment**
- From: the comment is written only at the settle after the continuation, and cleared only when no item holds.
- To: at every completed settle, an existing comment whose items differ from the current items is rewritten, including on the settle that requests a continuation. The first comment is still created only after the continuation. Equal items cause no write.
- Reason: the items changed at 16:49 on #268 (U3/U4 instead of U2), but nothing was written.
- Impact: non-breaking. A few more forge writes, only when the items changed.

**Shown `Incomplete` items**
- From: the step views (phase card, `spec_next`, `/livespec next`) show the items of the latest comment as recorded.
- To: a `<unit> is started` item is dropped when that unit is not started in the current state. Other items are shown as recorded.
- Reason: a recorded item can outlive the run that wrote it by hours.
- Impact: non-breaking. The display changes only.

**Unknown or refused writes are visible**
- From: an unknown state (forge unavailable, read-only or stale) or a refused write is only recorded as a session warning.
- To: the user gets a warning notification naming why the comment was not updated, and while the state is stale or read-only the card labels the line `Incomplete (may be stale)`.
- Reason: an invisible warning let a contradictory footer stand as fact.
- Impact: non-breaking.

## Capabilities

### New Capabilities

None.

### Modified Capabilities
- `settle-continuation`: the "Incomplete marker" requirement rewrites a differing comment at every completed settle, makes a skipped update visible, and labels a possibly stale line.
- `flow-engine`: the "Next step" requirement returns the incomplete items reconciled with the started units, not the raw recorded items.
- `context-injection`: the "Phase card content" requirement shows the reconciled incomplete items.

## Impact

- `src/hooks/settle.ts`: the write decision in `beforeSettle`, and a user notification on skip or refusal.
- `src/engine/next-step.ts`: the reconciled `incomplete` in `NextStep`.
- `src/hooks/phase-card.ts`, `src/tools/format-step.ts`: the `Incomplete` line label when the state is stale or read-only.
- `tests/hooks/settle.test.ts`, plus next-step and card tests.
- No new dependency, no schema or public API change.
