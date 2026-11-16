## Context

The next-step engine already computes a request's effective mode (`effectiveMode` in `src/engine/next-step.ts`). A question request takes its mode from the question's current class in the body; any other request takes its stored mode, where anything but `async` counts as blocking. The engine also treats applying requests as always blocking. `spec_gate` refuses through ordered pure rules in `src/engine/gates.ts`; `blockingQuestion`, `openStuck` and `capReached` come before the pending-request rule. All of these helpers are module-private. `planRefusal` and `stateRefusal` instead call `openRequests` from `src/interaction/requests.ts`, which ignores mode.

## Goals / Non-Goals

**Goals:**
- One definition of "this open request blocks planning", built on the engine's effective mode.
- `unit_amend` reuses the gate's blocking-state rules and their messages verbatim.

**Non-Goals:**
- No change to `spec_gate`'s rule order or messages, to `nextStep` output, or to answer validation in `src/interaction/complete-validate.ts`.

## Decisions

**D1: The effective mode moves to a shared engine module.** `effectiveMode` moves from `next-step.ts` to a new `src/engine/request-mode.ts`, unchanged; `next-step.ts` imports it.
- The same module adds `blockingRequests(state)`, which returns the open requests that block planning, in pending-then-applying order:
  - every applying request;
  - every pending request whose subject does not start with `question:`, whatever its stored mode;
  - a pending question request unless its question is in `## Questions` with class `non-blocking`. This reads the live class as `effectiveMode` does. Unlike `effectiveMode`, it does not fall back to the stored mode when the question is missing from the body: a lost question blocks, so planning stays conservative. `effectiveMode` itself, and so the next step, is unchanged.
- Why not filter on stored mode for every kind: issue #17 lists `gate:`, `amend:`, `stuck:` and `decide:` as always blocking. A chain deferral can store `async` on a request, and that must not unblock planning for a non-question.
- Why a new module: `next-step.ts` holds the precedence rules. Engine-level request facts have no home yet, and `interaction/requests.ts` derives lifecycle facts from comments without looking at the body.

**D2: The blocking-state rules get a narrow export.** `gates.ts` exports `blockingStateRefusal(state)`, which runs `blockingQuestion`, `openStuck` and `capReached` in that order and returns the first message. `gateRefusal` keeps its order by calling the same rules from its `REFUSALS` list, so there is no duplication. Why not reuse `gateRefusal` itself: see brainstorm Alternative C.

**D3: Refusal order in the tools.**
- `planRefusal` keeps its order and only swaps `openRequests` for `blockingRequests`: phase, lock, dirty tree, then request.
- `stateRefusal` checks, in order: the lock, then `blockingStateRefusal`, then `blockingRequests`. The blocking-state refusal is prefixed with `unit_amend refused: `.
- Blocking state comes before requests, matching `gateRefusal`. A blocking question usually also has a pending request, and the question is the more actionable reason.

## Risks / Trade-offs

- [A question request is pending while its body line was rewritten to non-blocking by hand] → This is the intended "current class" semantics, the same as the next step.
- [A non-blocking question's answer lands while `plan_units` is mid-write] → Planning was allowed while it was pending. Once the answer is recorded the request is applying and blocks, and the version-checked body write catches a concurrent body change.
- [Moving `effectiveMode` could change next-step output] → The move is pure, and the existing next-step tests cover it.
