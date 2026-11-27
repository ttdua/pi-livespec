## Design Summary

Issue #66: when a child ends without a usable structured result, `settle()` spawns a brand-new child for the same unit and packet. The new child has no context, often repeats the previous question, and the subagent widget shows two implementers for one unit. Because `subagent_answer` restarts `settle()` with a fresh retry budget, a QUESTION → ANSWERED → no-result loop respawns without bound (9 agent ids in 30 minutes in naicoi92/iroh-tunnel#268).

Living spec involved: `subagent-dispatch` › "Result handling" says a run with no structured result "SHALL be retried once with the identical packet", and scenario "Crash retried once" requires the retry to use the same packet hash. This change **alters that specified requirement**: the first remedy becomes resuming the same child, and a fresh launch becomes a recorded fallback. "Dispatch tool" gains a one-live-dispatch-per-target rule, and "Dispatch record" gains the `RETRY` record.

Agreed behaviour:
1. Missing or invalid result → resume the same child once, asking it to submit its result with the result tool. If the resumed run still has no usable result → `BLOCKED`.
2. Resume refused or failed → spawn exactly one new child with the identical packet, post a `retry` dispatch record naming the old and new agent ids and the reason, and say so in the tool result.
3. `subagent_dispatch` refuses when the same target already has a dispatch in flight in this session, or has a pending QUESTION whose child the executor still knows. The refusal names the agent id. A pending QUESTION whose child the executor no longer knows does not block (the spec already says the parent then dispatches again).

Goals: no silent respawn; one live child per target; the answer path cannot loop. Non-goals: #67 (how the parent answers stop orders); changing the `return` path for missing sources. Anti-goal: a unit that can never be dispatched again because of a stale question.

## Alternatives Considered

### Alternative A: Keep respawn, only record it and cap it across `subagent_answer`
- **Approach**: Keep `launch()` for a missing result, post a `retry` record and carry the retry count through `subagent_answer`.
- **Pros**: Smallest diff; matches the current spec wording.
- **Cons**: The new child still loses all context and asks again; the user still sees duplicate implementers.
- **Why not chosen**: Leaves the root cause (fresh context) in place.

### Alternative B: Always block on a missing result
- **Approach**: No retry at all; a missing result marks the unit `BLOCKED`.
- **Pros**: Simplest; no duplicates ever.
- **Cons**: A transient crash or a child that just forgot the result tool costs a stuck report.
- **Why not chosen**: Too harsh; a resume usually recovers the result cheaply.

### Alternative C: Stale questions always block, with a tool to discard them
- **Approach**: Rule 3 refuses on every pending QUESTION; a new tool cancels stale ones.
- **Pros**: Strict.
- **Cons**: New public tool; a reload that loses the executor's child would wedge the unit until the parent learns the new tool.
- **Why not chosen**: The user chose to refuse only while the executor still knows the child.

## Agreed Approach

Resume first, respawn as a recorded fallback, and one live dispatch per target, with stale questions (child unknown to the executor) not blocking. It reuses the existing resume path of missing sources and keeps the spec's "dispatch again" escape for lost children.

## Key Decisions

- The resume counts as the single missing-result retry; there is no second resume and no respawn after a resumed run fails.
- At most one fallback respawn per dispatch: a child that is itself a fallback (named as `newAgentId` in a `RETRY` record) is never replaced, so the answer path cannot loop through refused resumes.
- The fallback respawn is the only fresh launch and is always recorded with a `retry` dispatch record.
- A target is role + unit + subject (+ finding for a verifier).
- Pending-question blocking applies only when the executor still knows the child (user decision).

## Open Questions

None.
