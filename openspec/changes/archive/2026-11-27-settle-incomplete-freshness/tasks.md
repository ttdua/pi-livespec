## 1. Reconciled incomplete items in the step views

Blocked by: none

- [x] 1.1 Add the pure `src/engine/incomplete-items.ts` with `startedItem(id)` and `reconcileIncomplete(items, started)` (design D3); unit-test drop, keep, order and non-unit items (flow-engine "Finished unit dropped…", "Still-started unit kept", "Other items kept as recorded")
- [x] 1.2 Use `startedItem` in `settleItems` (`src/hooks/settle.ts`) and `reconcileIncomplete` for `step.incomplete` in `nextStep` (`src/engine/next-step.ts`); extend `tests/engine/next-step.test.ts`
- [x] 1.3 Label the line `Incomplete (may be stale)` when `state.stale || state.readOnly` in `src/hooks/phase-card.ts` and `src/tools/format-step.ts`; extend `tests/hooks/phase-card.test.ts` and `tests/tools/format-step.test.ts` (context-injection "Incomplete items after a receipt", "Possibly stale incomplete items"; settle-continuation "Step text labels possibly stale items")

## 2. Settle rewrites differing comments and surfaces skipped updates

Blocked by: 1

- [x] 2.1 Add the #268 repro test in `tests/hooks/settle.test.ts` (U2 started → comment written → new prompt: U2 receipt, U3/U4 started → first settle) and confirm it fails before the fix (settle-continuation "Rewritten at the continuation settle")
- [x] 2.2 Implement the D1 write decision in `beforeSettle`: ordered-list comparison with `card.state.incomplete`, rewrite an existing comment at the continuation settle, no first comment before the continuation, no write on equal items, rewrite or create after the continuation (scenarios "No first comment before the continuation", "Equal items are not rewritten", "Rewritten after the continuation")
- [x] 2.3 Isolate the continuation-settle write so a failure keeps the continuation (D2, "Failed rewrite keeps the continuation")
- [x] 2.4 Add a guarded `ctx.ui.notify` warning for an unknown read-only/stale state with recorded items, a refused write and a thrown write error; forge-unavailable stays record-only (D4; "Read-only forge", "Stale state is notified", "Unknown state without items is quiet", "Refused write is notified")
- [x] 2.5 Extend the repro test to the full #268 sequence (U3/U4 finished → review) and assert the comment is empty and the card shows no `Incomplete` line; run `bun run test` and `bun run typecheck`
