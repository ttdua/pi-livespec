## Why

When a child ends without a structured result, `settle()` silently spawns a new child for the same unit. The new child has no context, repeats its question, and the parent sees two implementers for one unit. Through `subagent_answer` this repeats without bound (issue #66: 9 children in 30 minutes). Resuming the same child keeps its context and stops the duplicates.

## What Changes

**Missing result handling**
- From: a run with no structured result is retried once by launching a new child with the identical packet, with no record.
- To: the same child is resumed once and asked to submit its result; only when the resume is refused or fails is one new child launched, recorded with a `retry` dispatch record naming both agent ids and said in the tool result.
- Reason: a fresh child loses context and duplicates work.
- Impact: non-breaking for callers; adds a `RETRY` status to `dispatch` records. Rolling back to an older version makes it report those records as invalid and ignore them.

**One live dispatch per target**
- From: `subagent_dispatch` launches even while the same target runs or waits on an answer.
- To: it refuses, naming the agent id, while the target has a dispatch or answer in flight in this session or a pending question whose child the executor still knows.
- Reason: prevents duplicate children for one unit.
- Impact: non-breaking; a stale question (child unknown to the executor) still allows a new dispatch.

## Capabilities

### New Capabilities

### Modified Capabilities
- `subagent-dispatch`: "Result handling" (resume instead of respawn, recorded fallback), "Dispatch tool" (refuse a second live dispatch), "Dispatch record" (`retry` record).

## Impact

- `src/subagents/dispatch.ts`, `src/subagents/result.ts`, `src/subagents/records.ts`, `src/subagents/validate.ts`, `src/subagents/run-record.ts`
- `src/tools/subagent-dispatch.ts`, `src/tools/subagent-answer.ts`, `src/tools/subagent-outcome.ts`
- Tests under `tests/subagents/` and `tests/tools/`
