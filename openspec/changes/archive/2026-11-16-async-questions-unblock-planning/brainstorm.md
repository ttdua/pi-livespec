## Design Summary

Follow-up to issue #5 (LS-05), from verify warnings W8 and W9 of `gates-and-decisions`, tracked as issue #17.

**Intent.** Issue #5 promises two things that the shipped tools do not keep:
- while a non-blocking question is open, "other work continues meanwhile";
- "a blocking question keeps every gate closed".

Today `plan_units` and `unit_amend` refuse while *any* request is open, including an async question that may wait on the forge for days (W8). The `unit_amend` light gate also ignores the blocking state that every other gate respects: an open blocking question, an unanswered stuck report, and a blocking `change_iterations` cap (W9).

**Existing requirements this change alters** (stated explicitly, not re-decided silently):
- `unit-planning/Requirement: Plan units tool`: the refusal "a request is pending" narrows to "a blocking request is open".
- `unit-planning/Requirement: Unit amendments`: the refusal "when a request is pending" narrows the same way. The tool also gains refusals for an open blocking question, an unanswered stuck report and a blocking iteration cap.
- Consistent with, and unchanged: `questions-and-stuck/Requirement: Question answers` ("A pending question request SHALL take its effective mode from the question's current class. … No gate SHALL open while a blocking question is open"), `Requirement: Iteration cap` and `Requirement: Stuck reports` ("every gate MUST refuse").

**Behaviour after the change.**
- An open request blocks `plan_units` and `unit_amend` when one of these holds:
  - it is a `gate:`, `amend:`, `stuck:` or `decide:` request;
  - it is a question request whose question is currently blocking;
  - it is applying: its answer is recorded and its effects are not yet complete. This holds whatever its class.
- A pending (unanswered) non-blocking question does not block either tool. The same goes for a question reclassified to non-blocking with `/livespec class`.
- `unit_amend` refuses, writing nothing and sending no request, while:
  - a blocking question is open in `## Questions`;
  - a stuck report is unanswered;
  - the `change_iterations` cap is blocking.

  These are the same conditions, and the same messages, as `spec_gate`.

**Goals.** Async questions stop stalling planning. The amendment light gate behaves like every other gate with respect to blocking state.

**Non-goals.**
- No change to `spec_gate`, the next-step engine, or how questions are classified or reclassified.
- No change to answer validation: an amendment answer is not superseded because a blocking question, a stuck report or the cap appeared while it was pending.

**Anti-goals.** Two different notions of "blocking request" in the codebase, one for the next step and one for the tools. A pending non-blocking question that lets a tool run while that question's answer is mid-cascade.

## Alternatives Considered

### Alternative A: Shared blocking predicates reused by the tools
- **Approach**: expose one "is this open request blocking" rule, the same one the next step already uses, and the gate's blocking-state rules. Both tools call them.
- **Pros**: a single source of truth, so the tools, next step and `spec_gate` cannot drift apart; messages match `spec_gate`.
- **Cons**: touches engine modules (moving or exporting today's private helpers).
- **Why not chosen**: chosen.

### Alternative B: Inline checks in each tool
- **Approach**: each tool filters requests and checks questions, stuck reports and the cap itself.
- **Pros**: smallest diff, local to the two tools.
- **Cons**: duplicates rules that already exist in the next step and the gates, which W9 itself shows can drift.
- **Why not chosen**: it repeats the drift that caused W9.

### Alternative C: Run `unit_amend` through `gateRefusal` as a named gate
- **Approach**: register the amendment as a gate target and call `gateRefusal` wholesale.
- **Pros**: maximal reuse.
- **Cons**: drags in rules that do not fit an amendment: the phase-gate checks, the dirty tree, frozen or stale units (an amendment is how those get fixed), and pending requests by subject. It would need exceptions for most of them.
- **Why not chosen**: needs more exceptions than it saves.

## Agreed Approach

Alternative A. Planning and amendment respect exactly the blocking notion the rest of the engine uses. A pending async question no longer stalls them. The amendment gate refuses under the same blocking state as `spec_gate`.

## Key Decisions

- **Applying requests always block** (user-approved). A request whose answer is recorded but whose effects are incomplete blocks both tools, even a non-blocking question. Such an answer may cascade: it moves the change to `define` and unticks units. That state normally lasts only until the next poll.
- **No re-validation at answer time** (user-approved). The new blocking-state refusals apply when `unit_amend` is called, not when its answer is validated. Answer validation keeps its current digest, done-state and plan-validity checks.
- **Question class is read live.** A question request's blocking state follows the question's current class in the body, as the next step does, so a reclassification takes effect at once.
- **Messages match `spec_gate`** for the blocking question, stuck report and cap refusals, prefixed by the tool name.

## Open Questions

None.
