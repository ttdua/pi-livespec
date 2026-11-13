# 0006: Decision points use rules; Jev is a later upgrade

Status: Accepted (2026-11-13)

## Context

Several steps need a classification: the lane, unit tags, unit difficulty, which durable docs a change must update, where a finding belongs. When the agent self-assesses these, it tends to rationalize its way around steps. A fast classifier (Jev, through pi-jev-pilot) could decide them, but it adds an external service and needs changes in another repository.

## Decision

- Every decision point goes through one seam, `decide(point, facts)`. The facts come from code (paths, diff stats, parsed issue fields, exit codes, counters), never from the agent's own account.
- v1 has only `mode: rule`. Each point has exactly one rule: built from facts, conservative by default, or handed to a human gate.
- Tools write the outcomes. The agent cannot edit them. Where a rule accepts input from the agent (tags), the agent may only add.
- Every decision is stored as a decision record on the issue, or in the pull request body in the small-fix lane. A human override at a gate is recorded too.
- Jev is deferred to a later upgrade. When it arrives, a point set to `mode: jev` is decided by Jev, and its v1 rule becomes the fallback.

## Consequences

- The workflow runs fully without any external classifier.
- In three places v1 still relies on the agent's own statement: choosing the lane, writing `not needed` for a durable doc, and judging whether a change needs a new file in `specs/decisions/`. Post-checks and human gates catch these.
- The decision records collected in v1 become labelled data for calibrating Jev later.
