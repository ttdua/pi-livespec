## Design Summary

Issue #64. Today the `behavior-change` decision point always asks a human, once per capability, whether code under that capability's `paths` changed behaviour while its spec was not edited. To answer correctly the human has to read the diff, but the agent already has it, and at review the reviewer has read it too. In practice the human answers `unchanged` without checking. That breaks approver-adapters "Interaction contract" item 1: a fact the diff can give MUST NOT be asked.

Intent: the system concludes with evidence, and the human only reacts to disagree.

Existing requirements this change alters (each one explicitly):
- durable-doc-checks "Behavior change rule": "SHALL always ask a human" goes away. The rule no longer asks; the conclusion comes from the agent or the reviewer.
- durable-doc-checks "Behavior change question at the gate": the per-capability dialog at `spec_gate define|review` is removed. It is replaced by an agent conclusion recorded at the gate and shown in the gate briefing.
- durable-doc-checks "Behavior change check": an item with no conclusion still errors, but the message names the missing agent conclusion, not a human question. `changed` with no spec edit still errors, naming `specs/<capability>/spec.md`.
- phase-gates "Gate tool": the "behavior-change exception" to "refuse, writing nothing" (asking before the refusals) is replaced. The conclusion records are written only after every other refusal passes, the same as before.
- ship-phase "Durable docs rule and check": the latest `behavior-change` record counts whatever its source (`agent`, `reviewer` or `human`), not only `human`.
- decision-seam "Decision records": `behavior-change` records may carry source `agent` or `reviewer`, with the rationale as `reason`.
- request-briefing / phase-gates "Gate review payload": the define and review gate requests list one line per behavior item, giving the conclusion, its source and its rationale, under a livespec-computed "Please check" section.
- approver-adapters (forge commands and dialog): a structured way to flip a conclusion when requesting changes (see Agreed Approach).

Goals:
- A code-only change touching two capabilities reaches the define gate with no extra dialog, and the gate shows both conclusions with their rationale.
- Enforcement unchanged: `changed` without a spec edit blocks the gate; a reviewer dispute blocks review.
- The ship gate no longer repeats the question for a capability concluded `unchanged` over the same files.

Non-goals:
- No change to how behavior items are computed (durable-doc-checks "Behavior change facts").
- No change to the `specs/constraints.md` + ADR confirmation item at ship.
- No automatic inference of `changed` from the diff. The agent concludes, and review checks it.

Anti-goals:
- A conclusion with an empty or boilerplate rationale counts as evidence. The rationale is required and has a length limit; review is what judges whether it is true.
- The human must open anything extra to approve. Flipping a conclusion is optional and never blocks submission (Interaction contract item 4).

## Alternatives Considered

### Alternative A: Structured override, like unit overrides (chosen)
- **Approach**: the agent passes its conclusions to `spec_gate define|review`. At review the reviewer may add a conclusion of its own. To flip a conclusion to `changed`, the human uses a structured override that is only valid together with request changes: in the dialog, a behaviour list on its own tab; on the forge, a command `/livespec set behavior <capability> changed`. It records `source: human`.
- **Pros**: parsed without ambiguity; follows the existing unit-override pattern; the human approves in one pick.
- **Cons**: extends the forge command grammar and the dialog.
- **Why chosen**: the user picked it; it is the only reliable way to flip a conclusion.

### Alternative B: Parse request-changes notes
- **Approach**: when request-changes notes contain `behavior <cap> changed`, flip that conclusion.
- **Pros**: no UI or grammar change.
- **Cons**: ambiguous free text, and easy to miss or mis-trigger.
- **Why not chosen**: the result is not reliable.

### Alternative C: Keep the question, add an agent recommendation
- **Approach**: keep the dialog, but prefill the agent's conclusion as the recommendation.
- **Pros**: smallest change.
- **Cons**: the human is still asked something the diff answers; it is still one dialog per capability.
- **Why not chosen**: it still breaks Interaction contract item 1.

## Agreed Approach

Alternative A.

- **Agent conclusion (proposal):** `spec_gate define|review` takes a `behavior` parameter: per item, `capability`, `outcome` (`unchanged` or `changed`) and a required one-line `rationale` citing evidence. Missing or extra capabilities are refused, writing nothing. After every other refusal passes, each conclusion that differs from the latest matching record is recorded as a `decision` with `source: agent`, plus point, subject, files, digest and facts as today.
- **Reviewer conclusion (proposal):** the review packet carries the agent's conclusions. The reviewer's result MAY confirm or dispute each one. A dispute (`changed` against `unchanged`) is recorded as `source: reviewer` and is a blocking finding, so review cannot pass on the agent's word alone.
- **Precedence:** the latest record for the item's digest wins, except that a human `changed` override is never replaced by a later agent `unchanged`.
- **Human override:** when the human requests changes with an override naming a capability, the conclusion is recorded `changed` with `source: human`, and the check then requires the spec edit.
- **Ship:** a capability whose latest conclusion is `unchanged` and covers the files gets no confirmation item. The only remaining item is `specs/constraints.md` together with an ADR.

## Key Decisions

- The human flips a conclusion through a structured override valid only with request changes (user decision, Alternative A).
- The agent passes its conclusions to `spec_gate` rather than through a separate tool (my call: one call, and the gate is already where they get checked).
- A reviewer dispute is recorded as its own conclusion and blocks review (my call: this keeps the issue's "finding that disputes unchanged blocks review" and gives `source: reviewer` a concrete meaning).
- A human `changed` wins over a later agent `unchanged` for the same files (my call: an agent must not undo the human's authority decision).
- The `ask` path and `behavior-ask.ts` are removed; no config mode keeps the old dialog (my call: a fallback would keep the failure the issue describes).

## Open Questions

- None blocking. Exact parameter, result-field and command names are left to design.
