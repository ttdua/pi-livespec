## 1. Briefing core

Blocked by: none

- [ ] 1.1 Add `Briefing` and `RequestOption.description` to `src/interaction/approver.ts`; carry `briefing` on `RequestRecord` and `ApprovalRequest`, and store it through `prepareRequest` in `src/interaction/requests.ts`
- [ ] 1.2 Create `src/interaction/briefing.ts` with `validateBriefing`, `validateOptionTexts` (shape rules of request-briefing "Briefing shape") and `neutralise` (request-briefing "Agent text is untrusted")
- [ ] 1.3 Unit tests in `tests/interaction/briefing.test.ts` for every shape rule, code-point counting, offered-choice check, neutralisation of `<!--` and `/livespec` lines, and tolerant reading of records without a briefing

## 2. Forge request text and built-in action descriptions

Blocked by: 1

- [ ] 2.1 Create `src/interaction/describe-actions.ts`: `offeredChoiceIds`, `gateChoices` (approve hidden while a waivable check fails, `waive` listed once) and livespec-written descriptions per target (request-briefing "Built-in action descriptions")
- [ ] 2.2 Create `src/interaction/forge-text.ts` with `renderForgeRequest` (heading, facts, checks table, briefing with author label, "How to answer" table, `<details>` command list, `|` escaping, neutralising stored text on render); replace `plainText` in `src/interaction/forge.ts`
- [ ] 2.3 Tests in `tests/interaction/forge-text.test.ts` and `tests/interaction/forge.test.ts` for structure, order, author label, question candidate rows and the free-text row, the prefilled command parsing back through `parseCommand`, and a pre-change request rendering without a briefing

## 3. In-session presentation

Blocked by: 2

- [ ] 3.1 Add pure `menuEntries` and `titleWithBriefing` in `src/interaction/menu.ts`; rework menus in `src/interaction/in-session.ts`: title = facts then briefing, entries `<label> — <description>`, recommended first with ` (Recommended)`, no `[id]` suffix, identity through the menu table
- [ ] 3.2 Question flow with candidates: pick a candidate, write own answer, or answer later; still ask whether the answer changes a requirement
- [ ] 3.3 Add a shared test helper that picks a menu entry by its leading label, and move every fake UI that scripts `select` to it (`tests/interaction/in-session.test.ts`, `tests/tools/{spec-gate,spec-gate-behavior,spec-question,spec-stuck,decide-ask,plan-units,change-ship,unit-amend,initiative-propose,new-dependency}.test.ts`, `tests/e2e/{gates-flow,initiative-flow}.test.ts`), so tests keep passing with the new labels

## 4. spec_gate and proposer briefings

Blocked by: 3

- [ ] 4.1 Add the `briefing` parameter to `spec_gate` in `src/tools/spec-gate.ts`: shape validation before checks for human targets, ignored for self gates, `approve` not recommendable while a waivable check fails (refused after `planGate` by `recommendationRefusal`), briefing passed into `gateRequest`
- [ ] 4.2 Optional `briefing` on `initiative_propose` and `new_dependency` through `sendNamedGate`
- [ ] 4.3 Add a valid fixture briefing to every test that runs a human `spec_gate` (`tests/tools/spec-gate*.test.ts`, `tests/tools/spec-question.test.ts`, `tests/evidence/red-on-base.test.ts`, `tests/e2e/*`, `tests/tools/change-ship.test.ts`, `tests/tools/spec-review.test.ts`) and add the new phase-gates scenarios; give the `STUCK` fixture in `tests/e2e/gates-flow.test.ts` descriptions and a rationale

## 5. Stuck report descriptions and rationale

Blocked by: 3, 4

- [ ] 5.1 `spec_stuck` in `src/tools/spec-stuck.ts`: required option `description` and `rationale`, hypothesis within the summary limits, briefing built from hypothesis, recommended and rationale; neutralise where, tried and hypothesis
- [ ] 5.2 Lenient `storedReport` so a report stored before this change is re-sent without a briefing
- [ ] 5.3 `stuckFor` in `src/subagents/finish-freshness.ts` supplies descriptions and a rationale and caps the hypothesis by code points; tests in `tests/tools/spec-stuck.test.ts` and `tests/subagents/freshness.test.ts`

## 6. Question candidates

Blocked by: 3, 4

- [ ] 6.1 `spec_question` in `src/tools/spec-question.ts`: optional `candidates` (2-4), `recommended` (`A`..`D`) and `rationale`; round-trip label rules; options `A`..`D`; nothing added to the `## Questions` line; `reask` uses the new candidates
- [ ] 6.2 Tests in `tests/tools/spec-question.test.ts` for the questions-and-stuck "Question tool" scenarios and the in-session candidate scenarios

## 7. Rule ask briefings

Blocked by: 4

- [ ] 7.1 Extend `RuleResult.ask` in `src/decide/registry.ts` and `DecisionAsk` in `src/decide/seam.ts` with option descriptions, `recommended` and `rationale`; `decide` validates option texts and throws when the recommendation is not an option
- [ ] 7.2 `decisionRequest` in `src/tools/decide-ask.ts` builds a rule-authored briefing only when the rule recommends; `behavior-change` in `src/docs/behavior-change.ts` gives option descriptions
- [ ] 7.3 Tests in `tests/decide/seam.test.ts`, `tests/tools/decide-ask.test.ts`, `tests/docs/behavior-change.test.ts`

## 8. Amendment briefing

Blocked by: 3

- [ ] 8.1 Optional `briefing` on `unit_amend` in `src/tools/unit-amend.ts`, validated before the classification decisions run, carried on the light gate request
- [ ] 8.2 Tests in `tests/tools/unit-amend.test.ts` for "Amendment with a briefing" and refusal before any `decide:` request

## 9. Documentation

Blocked by: 4, 5, 6, 7, 8

- [ ] 9.1 Update README.md and README.vi.md "Human gates" sections (briefing, recommended option, new forge comment layout, question candidates) and the tool parameter notes
- [ ] 9.2 Update `docs/architecture.md` (approver section) and add a CHANGELOG entry naming the breaking `spec_gate` and `spec_stuck` parameters
