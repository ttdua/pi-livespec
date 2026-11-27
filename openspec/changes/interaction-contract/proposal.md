## Why

Livespec asks the human too often, and sometimes asks what it could derive itself: every plan needs a human dialog, questions carry a class the human must manage, and many requests arrive without a recommendation, so the human analyses instead of confirming. Issue #65 sets one contract for every human-facing request and removes the interactions that break it.

## What Changes

**Interaction contract (new)**
- A request to the human SHALL ask only what only the human can answer, state each option's consequence, carry `recommended` and `rationale` with the recommended option first, and be answerable in one action.
- The request builder refuses a request without a recommendation or with an undescribed option. Reviewer rubrics cite the contract.

**Recommendation everywhere**
- From: the briefing (and so `recommended`) is optional on amendments, proposer gates, questions and rule asks.
- To: required on every request. `spec_question` needs two to four candidates and a recommendation; `unit_amend`, `initiative_propose` and `new_dependency` need a briefing with a recommendation; every rule ask names a recommendation (`behavior-change` recommends `unchanged`); finding-routing questions offer two fixed candidates. A stuck report stored before rationales existed is resent with a rationale built from it.
- Impact: breaking for agents that call these tools without the new fields (the tool refuses and names the field).

**Plan gate escalation**
- From: `plan` has `gate: human`.
- To: `plan` has `gate: self`; a new rule `gate-escalation` sends it to the human when a waivable check fails, the phase's advisory review at HEAD is missing or reports a `CRITICAL` finding, or a unit is tagged `security` or `migration`. The decision is recorded. Projects can set `gate: human` again.
- Impact: changes with none of the triggers pass plan without a human dialog.

**Units tab hidden**
- From: the dialog shows an Adjust units tab at plan and amendment gates.
- To: the dialog opens on Decision and Review; one key opens the units tab. Overrides keep working.

**Question class removed (human and agent)**
- From: the class is chosen by the agent (`class` parameter), by the human when answering (`--class`, dialog), or by `/livespec class`.
- To: questions are blocking; "answer later" is the only way a human makes one non-blocking; finding routing still raises its questions non-blocking from code. `/livespec class` and `--class` are refused as unknown.
- Impact: breaking for the `spec_question` `class` parameter and both forge commands.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `approver-adapters`: adds "Interaction contract", which reviewer rubrics cite; answers lose the question class; `class` commands removed; units tab hidden by default.
- `request-briefing`: `recommended` and `rationale` required on every request; options must be described; the forge table lists the recommended row first.
- `phase-gates`: self gate escalation through `gate-escalation`; proposer briefings required.
- `flow-pack`: `plan` defaults to `gate: self`; the pack configures `gate-escalation`.
- `questions-and-stuck`: candidates and a recommendation required; no class parameter or reclassification; legacy stuck resend gets a rationale.
- `decision-seam`: a rule ask must name a recommendation.
- `durable-doc-checks`: the `behavior-change` ask recommends `unchanged`.
- `finding-routing`: the `question` route sends fixed candidates and a recommendation.
- `unit-planning`: `unit_amend` requires a briefing with a recommendation.
- `subagent-policy`: an advisory result may escalate a self gate, which is not a block.
- `discovered-dependencies`: `new_dependency` requires a briefing; options are described and no option is labelled default.

## Impact

- Code: `src/interaction/` (requests, briefing, commands, forge-match, poll, in-session, dialog), `src/tools/` (spec-gate, spec-question, question-candidates, spec-stuck, unit-amend, decide-ask, new-dependency, initiative-propose), `src/decide/` (seam, new `gate-escalation` rule), `src/engine/gates.ts`, `src/docs/behavior-change.ts`, `src/deps/new-dependency.ts`, `src/review/` (routing question), `src/subagents/rubrics.ts`, `src/packs/agent-skills.yaml`.
- Tests: fixture `tests/fixtures/agent-skills.pack.json` and tests of the touched modules.
- Docs: `README.md`, `README.vi.md`, `docs/architecture.md` (plan gate, question class, commands).
- Tool API: `spec_question` (no `class`, candidates required), `unit_amend` and proposer tools (`briefing` required), forge grammar (`class`, `--class` removed). No new dependency, no data migration; stored requests and `class` markers stay readable.
