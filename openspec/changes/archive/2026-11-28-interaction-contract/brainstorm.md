## Design Summary

Source: issue #65. Livespec asks the human too often and asks things the system can derive. This change adds one requirement that every human-facing request must meet, enforces it where requests are built, and applies three simplifications found in the interaction review.

**Interaction contract.** A request to the human through the approver (gate, amendment, question, stuck report, rule ask) SHALL:

1. ask only what only the human can answer: an authority decision or information the system does not have; a fact derivable from git, specs, the diff or the ledger MUST NOT be asked;
2. state the consequence of each option in the request itself;
3. carry `recommended` plus `rationale`, with the recommended option listed first, so the human confirms instead of analysing;
4. be answerable in one action; optional extras (notes, overrides) never block submission.

The reviewer rubric names this requirement, so a new request that violates it is a review finding.

**Simplifications.**

- Plan gate: `gate: self` by default. The escalation applies to the phases the rule config lists (`plan` by default), so `shape` and `review` keep their self gates. It escalates to the human only when a waivable check fails (such as `size-limits`), an advisory reviewer reports a blocking finding, or a unit is tagged `security` or `migration`. Projects can set `gate: human` again.
- The Adjust units tab (Difficulty and Tags overrides) at plan and amendment gates is hidden by default and opened with one key. The rules still decide; overrides keep working.
- Question class: the human no longer picks a class (dialog, `--class`, `/livespec class`) and the agent loses the `class` parameter of `spec_question`. "Answer later" is the only way a human makes a question non-blocking. Questions that livespec code raises itself (finding routing) stay non-blocking, because code, not a person, decides that.

**Goals.** No human dialog during plan for a change with no waived check, no blocking finding and no security or migration unit. Every request the plugin sends carries a recommendation. Fewer, simpler interactions.

**Non-goals.** The `behavior-change` dialog content (#64), deriving the requirement cascade of `spec_question` (#63) and replacing the forge command syntax (#61) are tracked elsewhere. Define gate, ship gate, `spec_stuck`, the new-dependency gate, ambiguous account selection and the human merge stay as they are.

**Anti-goals.** An approval that no human gave; a plan gate that silently passes a waived check; a `recommended` choice applied without the human picking it.

## Existing requirements involved

This change alters these specified requirements explicitly:

- approver-adapters "Approver contract": answers lose the question class; requests must carry a recommendation.
- approver-adapters "Forge command comments": `class Q<n>` and `--class` are removed, with the `class` marker handling.
- approver-adapters "In-session adapter", "In-session dialog", "Dialog unit overrides": the units tab is hidden by default.
- questions-and-stuck "Question tool" and "Question answers": no class parameter or human reclassification; candidates and a recommendation become required.
- phase-gates "Gate tool" and "Waivable checks": a `self` gate may escalate to a human gate instead of refusing on a failing waivable check.
- flow-pack "Default flow pack": `plan` has `gate: self` and the pack gains the `gate-escalation` decision point.
- request-briefing "Briefing shape": `recommended` and `rationale` become required on every request.
- decision-seam "Decision seam": a rule ask must name a recommendation.
- subagent-packets (reviewer rubric): every rubric cites the interaction contract.

## Alternatives Considered

### Alternative A: `gate-escalation` decision point
- **Approach**: register a rule `gate-escalation` (`decisions.gate-escalation: { mode: rule }`). When a `self` gate runs, `spec_gate` asks it with facts computed by code (failing waivable checks, current blocking advisory findings of the phase, unit tags). It returns `self` or `human` with a reason, recorded as a `decision`. On `human` the gate sends the normal human request.
- **Pros**: reuses the decision seam; the reason for each escalation is in the ledger; projects tune triggers in `flow.yaml` or set `gate: human`.
- **Cons**: one more rule point and facts builder.

### Alternative B: new gate value `auto`
- **Approach**: add `gate: auto` to the pack schema with the triggers hard-coded in `spec_gate`.
- **Pros**: readable at a glance in the pack.
- **Cons**: changes the `gate` schema; triggers cannot be configured; no record explains why the human was asked.
- **Why not chosen**: loses the audit trail and configurability that A gets for free.

### Alternative C: keep `gate: human`, auto-approve without triggers
- **Approach**: the plan gate stays human but livespec approves it itself when no trigger holds.
- **Pros**: smallest code diff.
- **Cons**: writes an approval no human gave, breaking approver-adapters "Approver contract".
- **Why not chosen**: violates an anti-goal.

## Agreed Approach

Alternative A, chosen by the user. Escalation is a decision from facts, which is what the decision seam is for. The rule returns `human` only when a trigger holds, so `shape` and `review` (no waivable checks, no advisory reviewer) keep today's behaviour.

## Key Decisions

- Question class: option A (user). Remove every human and agent class choice; finding routing keeps raising non-blocking questions from code.
- Questions without candidates cannot carry a recommendation, so `spec_question` requires two to four candidates and `recommended` with `rationale`. The human stays free to write any other answer.
- Proposer gates and `unit_amend` require a briefing with `recommended` and `rationale`, like human phase gates.
- The `behavior-change` rule ask gains a rule-authored recommendation now; its content and whether it asks at all is #64.
- Account selection does not go through the `Approver` and the issue keeps it as is; the contract covers approver requests only, and forge-accounts is not changed.
- "Blocking finding" means a `CRITICAL` finding in the phase's advisory review at HEAD; the severity scale has no `BLOCKER`, and advisory findings cannot be rebutted. A missing advisory review at HEAD also escalates (my call: otherwise skipping the reviewer would skip the human).
- Old stored requests (no briefing, old stuck reports, stored `class`) keep being read and answered; the guard applies when a request is built.

## Open Questions

None.
