## Why

Two failure modes remain after LS-04. The agent can approve its own work, because nothing requires a human answer before a phase moves on. It also rates its own work, because nothing decides `Difficulty` and `Tags`, which pick reviewers and skills. LS-05 (issue #5) adds human approval through approver adapters that the agent cannot speak for, and adds rule-based decisions that tools record ([ADR 0006](../../../docs/decisions/0006-rule-based-decisions.md)).

## What Changes

- Add the `Approver` interface and two adapters:
  - **In-session** asks through `ctx.ui.*` when `ctx.hasUI` is true.
  - **Forge** posts a request comment, reads `/livespec …` command comments from users with `write` or `admin` permission, and polls them.
- Add the `interaction.adapter` config key, an ordered fallback list that defaults to in-session, and a doctor check that reports the adapter in use.
- Add the approval tools:
  - `spec_gate`, with `registerGate` for named gates, waivable checks offered at the gate, and `gate` comments written only by the plugin.
  - `plan_units`, the only tool that creates `## Units` before the lock. It merges the integration branch and sets `Base`, applies the `tags` and `difficulty` rules, and posts decision records.
  - Digest lock at plan approval, frozen units, and `unit_amend` (edit, `--add`, `--drop`) behind a light gate.
  - `spec_question` with Questions, and a cascade when an answer changes a requirement, counted against `change_iterations`.
  - `spec_stuck`, for stuck reports.
- Add the decision seam: `decide(point, facts)`, `registerRule`, decision records (issue comment, and the small-fix PR body format), the `decisions` pack sub-schema (`mode: rule` only), and the `tags` and `difficulty` rules with defaults in the default pack. Human overrides of `Difficulty` and `Tags` at the plan gate are recorded as `overridden_by`.
- Extend the change state, next step and phase card with:
  - pending approver requests;
  - frozen and stale units;
  - open stuck reports;
  - the `change_iterations` cap.
- Update `docs/architecture.md` (interaction, decide).

Deviations from the issue text:
- **`rpiv-ask-user-question` is not an approval channel.** Probe (j) found that another extension can settle its answer, so only `ctx.ui.*` is used.
- **No Plannotator adapter.** It is out of scope.
- **The forge request comment carries a plugin marker** (kind `request`), so a pending request survives sessions. It still explains the decision and the commands in plain text below the marker. A recorded answer is an own `answer` comment, so a partly applied completion can be finished later.
- **`change_iterations` is derived from own `stale` comments**, not from a `counter` comment, so a retried cascade cannot count twice.
- **Two decision records per unit**, one per decision point.
- **Approving the ship gate does not move the phase.** LS-09's `change_ship` does that.

Known gaps, closed by LS-06 guards:
- the agent posting `/livespec …` command comments from the same login through `gh` or `tea` in bash;
- the agent editing `.pi/livespec/flow.yaml` to lower a gate.

## Capabilities

### New Capabilities
- `approver-adapters`: the `Approver` contract, the in-session and forge adapters, the forge command grammar and permission rule, pending requests and polling, the `interaction.adapter` config and its doctor check.
- `phase-gates`: `spec_gate`, `registerGate`, per-phase gate behavior, waivable checks, `gate` comments, stale phases, and `dismissed` handling.
- `unit-planning`: `plan_units`, the digest lock, frozen units, `unit_amend`, and the classification consistency check.
- `questions-and-stuck`: `spec_question`, answers, cascade, the `change_iterations` cap and `spec_stuck`.
- `decision-seam`: `decide()`, `registerRule`, decision records, human overrides, the `decisions` pack sub-schema, and the `tags` and `difficulty` rules.

### Modified Capabilities
- `flow-engine`: **Next step precedence** gains the open stuck report, pending approver requests, the iteration cap, and frozen or stale units, and gives the ship-gate-approved sentence. **Change state from issue and git** gains gate, lock, request, stale and stuck facts read from own marked comments.
- `flow-pack`:
  - **Default flow pack** now fills `decisions` with the `tags` and `difficulty` defaults and adds the `unit-classification` check to `plan`, so the canonical fixture changes.
  - **Project override** now merges `decisions` per point through the rule's own merge, so tags are merged per tag instead of being replaced.
- `init-and-doctor`: **Config files** accepts `interaction.adapter` in project and user config.
- `context-injection`: **Phase card content** shows pending requests, frozen and stale units, and an open stuck report.

## Impact

- New modules `src/interaction/` (approver contract, adapters, command parser, pending requests) and `src/decide/` (seam, registry, records, rules). New tools in `src/tools/`. Changes to `src/engine/` (snapshot facts, next step, check registration with `waivable`), `src/config.ts`, `src/hooks/` (polling at session start, card sections), `src/commands/` (`/livespec next` polling, doctor check), `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json`.
- `Git` gains a merge operation for `plan_units`. No new runtime dependency.
- New marker kinds `request` and `answer`.
- `docs/architecture.md` gains the interaction and decide details.
