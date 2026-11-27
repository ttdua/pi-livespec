## 1. Forge row order and reviewer rubrics

Blocked by: none

- [x] 1.1 Sort the forge "How to answer" rows with the recommended row first, the question free-text row last (`src/interaction/forge-text.ts`; request-briefing "Forge request text", design D7)
- [x] 1.2 Append the interaction-contract sentence to every rubric, persona subjects included (`src/subagents/rubrics.ts`; design D8)

## 2. Question class removal and required candidates

Blocked by: none

- [ ] 2.1 `spec_question`: drop `class` from the schema and refuse it; require 2 to 4 candidates plus `recommended` and `rationale` on new questions and `reask`; keep an internal non-blocking origin for code (`src/tools/spec-question.ts`, `src/tools/question-candidates.ts`; questions-and-stuck "Question tool", design D5)
- [ ] 2.2 Finding routing raises its question non-blocking with the two fixed candidates, the first recommended (`src/review/effects.ts`, `src/review/stages.ts`; finding-routing "Route effects")
- [ ] 2.3 Remove `class` and `--class` from the command grammar so they are reported unparseable; stop applying and recording `class` commands and ignore stored `class` markers (`src/interaction/commands.ts`, `forge-match.ts`, `poll.ts`, `forge-permissions.ts`; approver-adapters "Forge command comments")
- [ ] 2.4 Remove `questionClass` from new answers; completion reads the class from the `## Questions` line, and a deferred answer still makes the question non-blocking (`src/interaction/approver.ts`, `in-session.ts`, `dialog/result.ts`, `complete-question.ts`; questions-and-stuck "Question answers")

## 3. Briefings and descriptions for every other request

Blocked by: none

- [ ] 3.1 `unit_amend` requires a briefing with `recommended` and `rationale`, refused before any `decide:` request (`src/tools/unit-amend.ts`; unit-planning "Unit amendments")
- [ ] 3.2 Proposer tools require a briefing: `proposerBriefing` refuses a missing one (`src/tools/spec-gate.ts`, `initiative-propose.ts`, `new-dependency.ts`; phase-gates "Gate tool")
- [ ] 3.3 Describe the `new-dependency` options and drop the default label (`src/deps/new-dependency.ts`; discovered-dependencies "New dependency tool")
- [ ] 3.4 Legacy stuck resend builds a briefing and option descriptions (`src/tools/spec-stuck.ts`; questions-and-stuck "Stuck reports")
- [ ] 3.5 `checkRuleAsk` throws without `recommended`, `rationale` or option descriptions; `behaviorChangeRule` recommends `unchanged` (`src/decide/seam.ts`, `src/tools/decide-ask.ts`, `src/docs/behavior-change.ts`; decision-seam "Decision seam", durable-doc-checks "Behavior change rule")

## 4. Request contract guard

Blocked by: 1, 2, 3

- [ ] 4.1 Add `assertContract` to `prepareRequest` (`src/interaction/requests.ts`): throw when the briefing, `recommended` or `rationale` is missing, `recommended` is not offered, or an offered option has no description (design D1; approver-adapters "Contract enforced at construction")
- [ ] 4.2 Update the request fixtures that build requests directly in tests to be contract-valid; keep stored-request read paths tolerant (approver-adapters "Stored request without a briefing still answered")

## 5. Plan gate escalation

Blocked by: 3, 4

- [ ] 5.1 Add the `gate-escalation` rule with its schema and list-replacing merge, and register it (`src/decide/rules/gate-escalation.ts`, `src/decide/registry.ts`; decision-seam "Gate escalation rule", design D4)
- [ ] 5.2 Build the facts from code: failing waivable checks, advisory review state at HEAD, unit tags (`src/engine/gate-escalation-facts.ts`; decision-seam "Gate escalation facts")
- [ ] 5.3 `spec_gate`: consult the rule for listed self phases, refuse a missing briefing before writing, record the decision once per facts, then pass or send the human gate with the reason in the payload (`src/tools/spec-gate.ts`; phase-gates "Self gate escalation", "Waivable checks")
- [ ] 5.4 Next step forecasts the escalation without writing (`src/engine/gate-decision.ts`; phase-gates "Escalation in the next step")
- [ ] 5.5 Default pack: `plan` `gate: self`, `decisions.gate-escalation`; update `tests/fixtures/agent-skills.pack.json` (`src/packs/agent-skills.yaml`; flow-pack "Default flow pack", "Project override")

## 6. Units tab behind a key

Blocked by: none

- [ ] 6.1 Dialog model shows Decision and Review only, with `unitsAvailable`; `u` on Decision adds and selects the units tab; key hint shown (`src/interaction/dialog/model.ts`, `keys.ts`, `state.ts`, `view.ts`; approver-adapters "In-session dialog", "Dialog unit overrides", design D6)

## 7. Documentation

Blocked by: 1, 2, 3, 4, 5, 6

- [ ] 7.1 Update `README.md`, `README.vi.md` and `docs/architecture.md`: self plan gate and its triggers, no question class or `class` commands, required briefings and candidates, hidden units tab
