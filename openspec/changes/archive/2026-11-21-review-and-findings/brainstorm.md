## Design Summary

### Intent

Review is the step agents skip or soften most often. This change (LS-08, issue #8) builds the `review` phase so that a change cannot reach `ship` without an independent, multi-lens review whose blocking findings are either fixed, refuted by an adversarial verifier, or explicitly routed elsewhere. Reviewers must not see each other's reasoning or the implementer's, false alarms must not block work, and every finding must have a route.

### Goals

- Fan out independent, read-only reviewers in clean contexts, in parallel when the executor allows it, in sequence otherwise (inline fallback).
- Pick reviewer personas from tags, re-evaluated against the files the change actually modified.
- Detect a lowered standard in the diff deterministically, without an LLM.
- De-duplicate findings, verify each blocking one adversarially, and route each by its location through the decision seam.
- Cap review rounds at `review_rounds` and escalate with `spec_stuck`.
- Provide `routeFinding(finding)` for LS-09 to reuse on pull request comments and CI failures.

### Non-goals

- Feeding pull request comments and CI failures into routing (LS-09).
- The small-fix lane and creating follow-up issues for out-of-scope findings (LS-09).
- Shipping agent files: livespec still launches the executor's role agents by role name.

### Anti-goals

- A reviewer or verifier that can be talked out of a finding by the implementer's narrative.
- A route chosen by the reviewer's own claim of scope instead of the finding's location.
- A review that passes while code changed after it was reviewed.

### Living specs touched

- `review-findings` — "Finding schema" (unchanged; personas and the verifier reuse it), "Blocking findings" (extended: `DISPUTED` findings do not block; review-phase routing replaces the reviewer's `scope` with the computed one), "Rebuttal" (unchanged: `missed-context` still cannot be rebutted), "Finding summary comment" (extended with an aggregate summary per review round).
- `subagent-packets` — "Context manifest" (the `verifier` manifest gains its finding input; today `findingAndCode` refuses because no tool gives it a finding). "Freshness before finish" says a stale source stops the unit "until review-phase routing exists"; this change does not alter that behaviour.
- `subagent-dispatch` — "Role agents" (unchanged: the issue's `livespec.finding-verifier` maps to the existing `verifier` role; no agent file is shipped).
- `subagent-policy` — "Default pack entries" (extended with `review` phase entries for the change reviewer, personas and the verifier).
- `decision-seam` — "Tags rule" (reused at review on the actual diff), "Rule registry" (new `finding-scope` rule).
- `phase-gates` — "Gate tool" (the `review` phase is already a `self` gate; its pass condition is defined here), "Gate review payload" (ship payload gains the review result, as that requirement anticipates).
- `questions-and-stuck` — `spec_question` for `needs-decision` findings, `spec_stuck` at the round cap.
- `unit-planning` — "Unit amendments" (`unit_amend --add` for `in-change` findings and the optional `simplify` unit).
- `flow-engine` — "Loop counters" (`review_rounds` counter).

### The review round, as agreed

1. **Tags re-checked.** The `tags` rule runs on the files of `git diff <Base>..HEAD`. Tags not already on any unit are recorded in one decision record for the change; unit bodies do not change. A new tag still adds its persona.
2. **Reviewer selection.** The change reviewer (agent-skills `code-reviewer` persona) always runs. `persona:security-auditor` runs for `tags:security`, `persona:web-performance-auditor` for `tags:perf` or `tags:ui`, `persona:test-engineer` for `units>=3`. These are declared as `review` phase entries in the default pack so a project override can change them.
3. **`constraints-not-weakened`.** A deterministic check of the diff creates a `CRITICAL` finding of kind `lowered-standard` for an added `.skip`/`.only`/`xit`, a `@ts-ignore`, a `@ts-expect-error` without a reason, an `eslint-disable`, a deleted test file, or a removed assertion.
4. **Fan-out.** One new tool, `spec_review`, launches every selected reviewer at once, waits for all of them, and records each run as today (one `finding-summary` per reviewer). Without a capable executor it returns the packets for inline review, in sequence, recorded with `subagent_record`.
5. **Aggregate.** Findings are de-duplicated by location and kind, keeping the highest severity, into one aggregate `finding-summary` for the round. Pull request review comments are posted when a pull request exists; otherwise only the issue summary.
6. **Verify.** Each `CRITICAL` or `WARNING` finding goes to the `verifier` role, which tries to refute it. A refuted finding becomes `DISPUTED` and does not block. `missed-context` findings skip the verifier and block directly, because `review-findings` already forbids rebutting them; a verifier refutation would be the same escape hatch.
7. **Route** each remaining finding through `decide("finding-scope", facts)`, with facts computed by code from the finding's path, every unit's `Files`, the change diff's file list, and the reviewer's `needs-decision` mark:
   - file in some unit's `Files` → `unit`: that unit is unticked and rebuilt through `unit_start`/`unit_finish`;
   - file in the diff but in no unit's `Files` → `in-change`: the next step is `unit_amend --add` with its light gate; no unit is created automatically;
   - file outside the diff → `out-of-scope`: non-blocking, listed as a follow-up in the summary;
   - `needs-decision` → a `spec_question`;
   - `SUGGESTION` → recorded only.
8. **After fixes,** `Verify` of every unit runs again at HEAD, then a new round reviews the new diff.
9. **Cap.** When round `review_rounds` (default 3) still ends with a blocking finding, the next step is `spec_stuck`.
10. **Gate.** `spec_gate review` (self) passes when the latest completed round at HEAD left no blocking finding; its `head_sha` is the reviewed commit, which LS-09 compares at ship.

### `code-simplification`

Optional. When used, it runs before the last review round as a unit titled "simplify", `Kind: refactor`, added through `unit_amend --add`, whose `Verify` is the full test suite and which must be green before and after. Code may not change after the final review unless it is reviewed again.

### Fan-out rules elsewhere

The same independence rules (clean context, read-only, no other reviewer's output) apply to the advisory define and plan reviews and to unit review; those already launch with `context: "fresh"` and their own packets, so no behaviour change is expected there beyond stating it.

### Docs

`docs/architecture.md` gains a Review section.

## Alternatives Considered

### Alternative A: One orchestrating tool `spec_review` (chosen)
- **Approach**: a tool spawns every selected reviewer at once (the executor's `spawn` returns an id immediately and `wait` is separate), waits for all, then aggregates, verifies, routes and posts.
- **Pros**: true parallelism; deterministic aggregation, de-duplication and routing in code; one place enforces independence.
- **Cons**: a large tool that must be split carefully into modules.
- **Why chosen**: the issue's core risk is the agent softening or skipping review; moving aggregation and routing into code removes that discretion.

### Alternative B: Phase card suggests each `subagent_dispatch reviewer …` in turn
- **Approach**: reuse the existing dispatch tool; the parent aggregates by itself.
- **Pros**: smallest code change.
- **Cons**: sequential; de-duplication and routing depend on the agent doing it right.
- **Why not chosen**: leaves exactly the discretion this change exists to remove.

### Alternative C: Verifier for every blocking finding, including `missed-context`
- **Approach**: treat `missed-context` like any blocking finding at the verifier.
- **Pros**: one uniform rule.
- **Cons**: reopens the escape hatch that `finding_rebut` already closes.
- **Why not chosen**: the user chose to keep `missed-context` blocking directly.

## Agreed Approach

Alternative A: a single `spec_review` tool orchestrates tag re-evaluation, persona selection, the `constraints-not-weakened` check, parallel fan-out with inline fallback, de-duplication, adversarial verification and routing through `decide("finding-scope")`. `routeFinding` is exported for LS-09. `missed-context` findings block directly without the verifier.

## Key Decisions

- (user) Fan-out through one orchestrating tool, `spec_review`.
- (user) `missed-context` findings skip the verifier and block directly.
- (user) A `unit`-routed finding on a ticked unit unticks it for a rebuild through `unit_start`/`unit_finish`, after which every unit's `Verify` runs again at HEAD.
- (user) An `in-change` finding makes the next step `unit_amend --add`; nothing is created automatically.
- (user) Personas are declared as `review` phase entries in the default pack, overridable per project.
- (agent call) The issue's `livespec.finding-verifier` maps to the existing `verifier` role; livespec ships no agent file, as `subagent-dispatch` requires.
- (agent call) Re-evaluated tags are recorded in one change-level decision record; unit bodies are untouched.
- (agent call) Before LS-09 there is no pull request in practice, so findings are posted only in the issue's `finding-summary`; posting pull request review comments is implemented for when a pull request exists.
- (agent call) The `constraints-not-weakened` check is deterministic code, not an LLM reviewer.
- (agent call) Inline review without a capable executor is allowed, as the issue says ("in sequence otherwise") and as `subagent-dispatch` "Inline fallback" already does; each inline run is recorded as inline in its `finding-summary`, so the reduced independence is visible in the gate payload rather than refused.
- (agent call) What blocks `spec_gate review`: an unverified `CRITICAL`/`WARNING` finding, a `missed-context` finding, and any finding routed `unit` or `in-change` until a later completed round at HEAD no longer reports it; a `needs-decision` finding blocks until its question is answered (as in `review-findings`). `DISPUTED`, `out-of-scope` and `SUGGESTION` findings never block.
- (agent call) A review round is one completed `spec_review` run at a new HEAD; `review_rounds` counts rounds per change, not per finding. Unit rebuilds and amendments between rounds keep their own caps (`unit_attempts`, `unit_rebuilds`).

## Open Questions

None blocking. Detailed mechanics (record ids, de-duplication key format, the `DISPUTED` representation, how removed assertions are detected) are left to `design.md`.
