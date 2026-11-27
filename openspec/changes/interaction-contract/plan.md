# Interaction Contract Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Every human request carries a described choice set and a recommendation, the plan gate asks the human only when a recorded rule says so, and the question class and units tab stop costing the human an action.

**Architecture:** One guard in `prepareRequest` enforces the contract for all five request builders; tools refuse missing fields earlier by name. A new `gate-escalation` decision rule, fed by code-built facts, turns a listed `self` phase gate into a human gate. The question class becomes code-owned; the dialog hides the units tab behind `u`.

**Tech Stack:** TypeScript (Bun, `bunx vitest`, `bunx tsc --noEmit`), `yaml` nodes for pack schemas, pi-tui for the dialog.

## Global Constraints

- Repository text (code comments, docs, user-facing strings, commits) in English.
- No new dependency, no data migration; stored requests, answers with `questionClass` and own `class` markers stay readable.
- Briefing limits stay as request-briefing "Briefing shape": summary and rationale ≤ 600 code points, no blank line; description one line ≤ 200.
- `verify` per task: `bunx vitest run <files>`; before each commit `bunx tsc --noEmit`; whole suite `bunx vitest run` at the end of each task.

## Review Focus

- A stored pending request without a briefing (written before this change) must still render, answer and complete on both adapters → Task 4 test `reads a stored request without briefing` in `tests/interaction/requests.test.ts`.
- `spec_gate plan` rerun after a refusal must not post a second identical `gate-escalation.plan` decision → Task 5 test `rerun posts no duplicate escalation decision`.
- `u` pressed while the note editor is open must type `u` into the note, not open the units tab → Task 6 test `u in the note editor is text`.
- A `/livespec answer Q2 text --class blocking` comment must leave Q2 open with a parse warning, not answer `text --class blocking` → Task 2 test in `tests/interaction/commands.test.ts`.
- Finding-routing reask of an existing question (`reask: Q<n>`) must send the fixed candidates, since `reask` now requires them → Task 2 test `reask of a routing question carries candidates`.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `spec_question` parameters | modified | `{ text?: string; reask?: string; candidates: {label,description}[2..4]; recommended: "A"\|"B"\|"C"\|"D"; rationale: string }`; `class` removed (a passed `class` is refused) | public |
| `unit_amend` `briefing` | modified | required `{ summary; watch?; recommended; rationale }` | public |
| `initiative_propose` / `new_dependency` `briefing` | modified | required, same shape as `unit_amend` | public |
| `spec_gate` `briefing` | modified | required when the target escalates, else as before | public |
| Forge command grammar | modified | `answer Q<n> <text>`; `class …` and `--class` removed (unparseable; `--changes` already removed by #73) | public |
| `decisions.gate-escalation` pack key | new | `{ mode: rule, phases: string[], tags: string[] }`; default `{ mode: rule, phases: [plan], tags: [security, migration] }`; override replaces each list | public |
| `plan` phase `gate` default | modified | `self` (was `human`) | public |
| `assertContract(input: PrepareInput): void` in `src/interaction/requests.ts` | new | throws `Error("request <subject>: <field> …")` | internal |
| `Answered.questionClass` | modified | removed from new answers; readers tolerate it | internal |
| `ApprovalRequest.question` | modified | `{ id: string; class: QuestionClass; requirements: string[] }` unchanged; `class` comes from the line | internal |
| `runSpecQuestion(p, ctx, o?: { origin?: "routing" })` | modified | `origin: "routing"` writes `(non-blocking)` | internal |
| `RuleResult.ask` | modified | `recommended: string; rationale: string` required; options `description: string` required | internal |
| `GateEscalationFacts` in `src/engine/gate-escalation-facts.ts` | new | `{ phase: string; head_sha: string; failing_waivable: string[]; advisory_review: "none"\|"missing"\|"critical"\|"clean"; units: { id: string; tags: string[] }[] }` | internal |
| `gateEscalationFacts(state: ChangeState, pack: Pack, phase: string, waivable: string[]): GateEscalationFacts` | new | pure | internal |
| `gateEscalationRule: RuleFn` / `gateEscalationSchema: RuleSchema` in `src/decide/rules/gate-escalation.ts` | new | outcome `"self"\|"human"`, reason string | internal |
| `decision` record `gate-escalation.<phase>` | new | `{ point: "gate-escalation", subject: <phase>, source: "rule", outcome: "self"\|"human", reason, facts: GateEscalationFacts }`, no unit digest; posted unless the latest record for that id has deep-equal `facts` (`head_sha` included, so a new HEAD records again) | internal |
| `BRIEFING_SCHEMA` | modified | `recommended` and `rationale` documented as required; listed in `required` of `unit_amend`, `initiative_propose`, `new_dependency` | public |
| `gateResultDecision(phase, successor, result, atHead, forecast?)` | modified | optional `forecast?: { outcome: "self"\|"human"; reason: string }` | internal |
| `MatchResult.classes`, `ClassChange` | modified | removed | internal |
| `GateOption.description` (`src/engine/gates.ts`) | modified | required (was optional) — deviation in Task 4: registered named-gate options must be described so `spec_gate` builds contract-valid requests | internal |
| `amendRequest(..., briefing: Briefing)` | modified | `briefing` required (was optional) — deviation in Task 4, production always passes one | internal |
| `escalationForecast(pack: Pack, state: ChangeState, phase: Phase): { outcome: "self"\|"human"; reason: string } \| undefined` | new | pure; undefined when the phase is not covered | internal |
| `DialogModel.unitsAvailable: boolean`, `DialogState.unitsOpen: boolean`, action `{ type: "openUnits" }`, `tabsOf(model, state)` | new | `DialogModel.tabs` holds only decision and review; `tabsOf` adds `units` once `unitsOpen` (deviation in Task 6: derivation lives in `state.ts`) | internal |
| `NEW_DEPENDENCY_OPTIONS` | modified | each `{ id, label, description }`; label of A without `(default)` | internal |

---

## Task 1: Forge row order and reviewer rubrics — implements 1

**Covers:** 1.1, 1.2
**Difficulty:** Easy
**Blocked by:** none

**Files:**
- Modify: `src/interaction/forge-text.ts`, `src/subagents/rubrics.ts`
- Test: `tests/interaction/forge-text.test.ts`, the rubric test beside `rubricFor` (`tests/subagents/roles.test.ts` or `tests/subagents/packet.test.ts`)

**Interfaces:** none new.

- [ ] **Step 1: Failing test** `recommended row first` in `tests/interaction/forge-text.test.ts`: stuck request A/B, B recommended → first table row is B and contains `(recommended)`; a question's free-text row stays last.
- [ ] **Step 2:** Sort rows in `forge-text.ts` (stable: recommended first, others in offered order, free-text row last). Run → PASS.
- [ ] **Step 3: Failing test** `every rubric names the interaction contract`: for subjects `spec`, `plan`, `unit`, `change`, `persona:security-auditor`, `rubricFor(s)` contains `approver-adapters "Interaction contract"`.
- [ ] **Step 4:** Append the shared sentence in `rubrics.ts` (design D8). Run → PASS.
- [ ] **Step 5:** `bunx tsc --noEmit && bunx vitest run` → green. Commit `feat(request-briefing): recommended row first and contract in reviewer rubrics`.

---

## Task 2: Question class removal and required candidates — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Modify: `src/tools/spec-question.ts`, `src/tools/question-candidates.ts`, `src/review/effects.ts`, `src/review/stages.ts`, `src/interaction/commands.ts`, `src/interaction/forge-match.ts` (drop `ClassChange`, `MatchResult.classes`, `appliedClasses`), `src/interaction/forge.ts` (imports `ClassChange`), `src/interaction/poll.ts`, `src/interaction/forge-permissions.ts`, `src/interaction/approver.ts`, `src/interaction/in-session.ts`, `src/interaction/dialog/result.ts`, `src/interaction/complete-question.ts`
- Test: `tests/tools/spec-question.test.ts`, `tests/tools/question-candidates.test.ts`, `tests/review/effects.test.ts`, `tests/interaction/commands.test.ts`, `tests/interaction/poll.test.ts`, `tests/interaction/forge.test.ts`, `tests/interaction/in-session.test.ts`, `tests/interaction/complete.test.ts`, `tests/interaction/dialog/host.test.ts`

**Interfaces:** Produces `runSpecQuestion(p, ctx, { origin: "routing" })`.

- [ ] **Step 1: Failing tests** in `tests/tools/spec-question.test.ts`:
  - `class parameter refused` — `{ text, class: "non-blocking", candidates…}` → isError, text contains `class was removed`, body unchanged.
  - `question without candidates refused` — `{ text }` → isError naming `candidates`, nothing written.
  - `reask needs candidates` — `{ reask: "Q1" }` → isError naming `candidates`, no request.
  - `blocking by default` — text + 2 candidates + `recommended: "A"` + rationale → line `- [ ] Q1 (blocking): …`, request mode `blocking`.
  - `routing origin writes non-blocking` — `runSpecQuestion(valid, ctx, { origin: "routing" })` → line `(non-blocking)`, mode `async`.
- [ ] **Step 2:** Run → FAIL. Implement: remove `class` from the schema and `SpecQuestionParams`; refuse a present `class`; `candidateShape` requires candidates, `recommended` and `rationale` (delete the "recommended and rationale need candidates" and "undefined without candidates" branches and update their tests in `tests/tools/question-candidates.test.ts`); `reask` uses the new call's candidates. Run → PASS.
- [ ] **Step 3: Failing tests** in `tests/review/effects.test.ts`: `routing question carries candidates` (request options A `apply the proposed fix`, B `leave it out of this change`, A recommended, rationale `The reviewer proposed a fix; applying it keeps the change consistent.`, line `(non-blocking)`) and `reask of a routing question carries candidates`. Implement in `effects.ts` (`ask`/`reask` deps carry the candidate params) and `stages.ts` (`origin: "routing"`). Descriptions exactly as finding-routing "Route effects". Run → PASS.
- [ ] **Step 4: Failing tests** in `tests/interaction/commands.test.ts`: `parseCommand("/livespec class Q2 non-blocking")` returns an error; `parseCommand("/livespec answer Q2 per-user --class blocking")` returns an error mentioning `--class`. Remove `class` verb, `CLASS_FLAG` and `Command.class`. Run → PASS.
- [ ] **Step 5: Failing tests** in `tests/interaction/poll.test.ts` / `forge.test.ts`, one per renamed-content scenario: class command not applied (Q2 stays blocking, no `class` comment, card warning "could not be parsed"); old `class` marker ignored; no body write for a `class` command. Remove `ClassChange`, `appliedClasses`, the `class` branch of `poll.ts`, and the skip in `forge-permissions.ts`. Replace or delete the old class tests. Run → PASS.
- [ ] **Step 6: Failing tests**: `in-session question answer has no questionClass`; `answer later defers as non-blocking` (unchanged `Deferred`); `complete question reads class from the line` (`tests/interaction/complete.test.ts`, answer without `questionClass`, line `(blocking)` → `question` comment class `blocking`). Remove `Answered.questionClass` from writers (`in-session.ts`, `dialog/result.ts`, `forge-match.ts`); `classOf` in `complete-question.ts` keeps reading a stored `answer.questionClass` for old answers, else the line. Run → PASS.
- [ ] **Step 7:** `bunx tsc --noEmit && bunx vitest run` → green. Commit `feat(questions-and-stuck): remove the question class choice and require candidates`.

---

## Task 3: Briefings and descriptions for every other request — implements 3

**Covers:** 3.1, 3.2, 3.3, 3.4, 3.5
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/tools/unit-amend.ts`, `src/tools/spec-gate.ts` (`proposerBriefing` only), `src/tools/initiative-propose.ts`, `src/tools/new-dependency.ts`, `src/deps/new-dependency.ts`, `src/tools/spec-stuck.ts`, `src/decide/seam.ts`, `src/decide/registry.ts` (`RuleResult` type), `src/tools/decide-ask.ts`, `src/docs/behavior-change.ts`
- Test: `tests/tools/unit-amend.test.ts`, `tests/tools/initiative-propose.test.ts`, `tests/tools/new-dependency.test.ts`, `tests/tools/spec-stuck.test.ts`, `tests/decide/seam.test.ts`, `tests/tools/decide-ask.test.ts`, `tests/docs/behavior-change.test.ts`

**Interfaces:** Produces `RuleResult.ask` with required `recommended`, `rationale`, option `description` (Task 5's rule never asks, so it is unaffected).

- [ ] **Step 1: Failing tests**: `unit_amend without a briefing` (refuses naming `briefing`, no `decide:` and no `amend:` request); `unit_amend briefing without recommended` (refuses naming `recommended`). Implement: required briefing validated before classification, with `recommended` required. Run → PASS.
- [ ] **Step 2: Failing tests**: `initiative_propose without a briefing` and `new_dependency without a briefing` refuse naming `briefing` and write nothing; `new_dependency recommended A first` (request options all described, first presented row is A marked recommended, no label contains `(default)`). Implement in `proposerBriefing` (required, `recommended` required) and `BRIEFING_SCHEMA` (description: required on human and escalated gates, amendments and proposer tools; `recommended` and `rationale` documented as required; `unit_amend`, `initiative_propose` and `new_dependency` list `briefing` in `required`) and `NEW_DEPENDENCY_OPTIONS` descriptions (one line ≤ 200, stating what approval of that option does, matching discovered-dependencies "New dependency options"). Run → PASS.
- [ ] **Step 3: Failing test** `old stuck report sent again` in `tests/tools/spec-stuck.test.ts`: stored S1 without descriptions or rationale → request options described `Option A of stuck report S1.`, briefing recommended = stored option, rationale `Recommended in stuck report S1.`. Implement in `stuckRequest`/`lenientTexts`. Run → PASS.
- [ ] **Step 4: Failing tests** in `tests/decide/seam.test.ts`: `rule ask without a recommendation` (test rule, described x/y, no `recommended` → `decide` throws `/recommended/`); `rule ask with an undescribed option throws`. Update existing test rules in `tests/decide/*`, `tests/tools/unit-amend.test.ts`, `tests/tools/decide-ask.test.ts` to describe options and recommend. Implement `checkRuleAsk`; `ruleBriefing` always builds the briefing. Run → PASS.
- [ ] **Step 5: Failing test** in `tests/docs/behavior-change.test.ts`: `always asks` also expects `recommended: "unchanged"` and the exact rationale from durable-doc-checks "Behavior change rule"; `rule ask carries descriptions` expects a briefing headed as a livespec rule. Implement in `behaviorChangeRule`. Run → PASS.
- [ ] **Step 6:** `bunx tsc --noEmit && bunx vitest run` → green. Commit `feat(request-briefing): require a recommendation on every request`.

---

## Task 4: Request contract guard — implements 4

**Covers:** 4.1, 4.2
**Difficulty:** Normal
**Blocked by:** Task 1, Task 2, Task 3 (Task 1 added: Step 5 asserts its row order and both edit `tests/interaction/forge-text.test.ts`)

**Files:**
- Modify: `src/interaction/requests.ts`
- Modify (fixtures only): tests that call `prepareRequest` or build `ApprovalRequest`/`RequestRecord` literals directly (`rg -l "prepareRequest|kind: \"stuck\"|kind: \"gate\"" tests`)
- Test: `tests/interaction/requests.test.ts`, `tests/interaction/forge-text.test.ts`

**Interfaces:** Consumes the compliant builders of Tasks 2 and 3. Produces `assertContract`.

- [ ] **Step 1: Failing tests** in `tests/interaction/requests.test.ts`:
  - `prepareRequest throws without recommended` — stuck input, options A/B described, briefing `{summary, author:"agent"}` → `toThrow(/recommended/)`.
  - `prepareRequest throws on an undescribed option` — gate input with option `{id:"accept",label:"Accept"}` and a valid briefing → `toThrow(/option accept/)`.
  - `prepareRequest accepts a gate whose built-ins are undescribed` — gate input, no options, briefing recommending `approve` → no throw.
  - `reads a stored request without briefing` — `readRequests` over a marked `request` comment lacking `briefing` returns it pending.
- [ ] **Step 2:** `bunx vitest run tests/interaction/requests.test.ts` → the three guard tests FAIL.
- [ ] **Step 3:** Implement `assertContract` and call it first in `prepareRequest`. Offered ids come from `offeredChoiceIds({ kind: choiceKindOf({kind, subject}), options, failingWaivable: failingWaivableOf(input.snapshot) })` (`describe-actions.ts`, `waive-rule.ts`); a question's offered ids are its option ids. Options checked for a description: `input.options` except `waive` (described by livespec, like the built-ins). Add test `waive recommended on a gate with a failing check passes` and `approve recommended while a check fails throws`.
- [ ] **Step 4:** Run the whole suite. A production builder that throws is a Task 2/3 gap: fix it in the builder, not by weakening the guard. Test fixtures that build requests directly get a described option set and a briefing with `recommended`/`rationale` (add `validBriefing(recommended)` to `tests/helpers/` if none exists).
- [ ] **Step 5: Test** `every request kind carries a recommendation` in `tests/interaction/forge-text.test.ts`: render a gate, an amendment, a question, a stuck report and a rule ask built by their real builders; each `request` comment has a briefing with `recommended` and `rationale` and lists the recommended row first.
- [ ] **Step 6:** `bunx tsc --noEmit && bunx vitest run` → green. Commit `feat(approver-adapters): enforce the interaction contract when building requests`.

---

## Task 5: Plan gate escalation — implements 5

**Covers:** 5.1, 5.2, 5.3, 5.4, 5.5
**Difficulty:** Very Hard
**Blocked by:** Task 3, Task 4

**Files:**
- Create: `src/decide/rules/gate-escalation.ts`, `src/engine/gate-escalation-facts.ts`, `tests/decide/gate-escalation.test.ts`, `tests/engine/gate-escalation-facts.test.ts`
- Modify: `src/decide/registry.ts` (after Task 3's `RuleResult` change), `src/tools/spec-gate.ts`, `src/engine/gate-decision.ts`, `src/engine/next-step.ts`, `src/packs/agent-skills.yaml`, `tests/fixtures/agent-skills.pack.json`; `src/ship/ship-steps.ts` only if the `gateResultDecision` signature change is not optional
- Test: `tests/tools/spec-gate.test.ts`, `tests/tools/spec-gate-behavior.test.ts`, `tests/interaction/forge.test.ts`, `tests/interaction/complete.test.ts`, `tests/engine/next-step.test.ts`, `tests/engine/pack-load.test.ts`, `tests/engine/checks.test.ts`, `tests/hooks/phase-card.test.ts`, `tests/e2e/gates-flow.test.ts`, `tests/e2e/initiative-flow.test.ts`, `tests/tools/plan-units.test.ts`, `tests/tools/change-split.test.ts`, `tests/initiatives/split.test.ts`, `tests/subagents/policy.test.ts` (every file that drives the plan gate: `rg -l "spec_gate.*plan|gate:plan|target: \"plan\"" tests`)

**Interfaces:** Produces `GateEscalationFacts`, `gateEscalationFacts`, `gateEscalationRule`, `gateEscalationSchema`, `escalationForecast` (see Contracts).

- [ ] **Step 1: Failing tests** `tests/decide/gate-escalation.test.ts`:
  - `no trigger` — facts `{failing_waivable: [], advisory_review: "clean", units: [{U1,[ui]},{U2,[]}]}`, config tags `[security, migration]` → `{ outcome: "self", reason: "no trigger" }`.
  - `every trigger named` — `size-limits`, `critical`, U3 `[migration]` → `human`, reason contains `size-limits`, `CRITICAL advisory finding`, `U3` and `migration`.
  - `missing advisory review` → `human`, reason contains `missing`.
  - `project adds a tag` — pack override `tags: [security, migration, api]` merged; U1 `[api]` → `human`.
  - schema: `phases: plan` (not a list) reports an error with line/column.
- [ ] **Step 2:** Implement rule, schema (`mode`, `phases`, `tags`; merge replaces each list set) and register in `registerBuiltinRules`. Run → PASS.
- [ ] **Step 2b: Pack default first.** Set `plan` `gate: self` and `decisions.gate-escalation: { mode: rule, phases: [plan], tags: [security, migration] }` in `src/packs/agent-skills.yaml` and the fixture JSON; update the spot check; change "Replace one key" in `tests/engine/pack-load.test.ts` to override `gate: human`. Then run the suite and, in every plan-gate test that expects a human request, either load a pack override `plan: { gate: human }` (tests about the human gate itself) or add a trigger (tests about escalation). Run → the only failures left are the new escalation tests below.
- [ ] **Step 3: Failing tests** `tests/engine/gate-escalation-facts.test.ts`: `facts from the ledger` (completed advisory `plan` review at HEAD with one WARNING → `clean`); `critical at HEAD` → `critical`; `review at older head` → `missing`; `inline review recorded with subagent_record counts`; phase without advisory reviewer → `none`. Implement `gateEscalationFacts` using `entriesFor(pack, phase)` (advisory, `mode: always`, role reviewer), `changeReviewDoneAt`, and the latest current `finding-summary` of that subject at HEAD. Run → PASS.
- [ ] **Step 4: Failing tests** in `tests/tools/spec-gate.test.ts` (one per phase-gates "Self gate escalation" scenario): plan without triggers passes alone (decision `self`, self `gate` comment with locked digests, phase `build`, no request); waived size limit asks the human (decision `human` naming `size-limits`, request offers `waive`); security unit asks the human (payload names U2 `security`); critical advisory asks; escalated gate without a briefing (refuses naming `briefing`, no decision comment, no request); project keeps a human plan gate (no decision, briefing required); unlisted `shape` unchanged; `rerun posts no duplicate escalation decision`.
- [ ] **Step 5:** Implement in `spec-gate.ts`: `briefingStep` (runs before checks) still requires a briefing for `human` phases and named gates, and for a covered `self` phase validates the shape only when one is passed; after `withGateChecks` and `gateRefusal`, compute facts and the pure rule; on `human` with no valid briefing refuse naming `briefing`, writing nothing; `planGate` gains an `escalate` input; the decision comment is skipped when the latest `gate-escalation.<phase>` record has equal facts; on `human` reuse the human path (`gateRequest`, overridable units, reason line in the payload summary). Run → PASS.
- [ ] **Step 6: Failing test** in `tests/engine/next-step.test.ts`: `next step names the escalation` (plan, checks pass, U1 `security` → text contains `will ask the human`, `U1`, `security`, `briefing`; no forge write); `missing review names the dispatch first` (phase-entry step precedes). Implement `escalationForecast` and pass its result to `gateResultDecision` as a new optional last parameter `forecast?: { outcome; reason }` used by `gateReady`; `next-step.ts` passes it, `ship-steps.ts` stays unchanged. Run → PASS.
- [ ] **Step 7:** Add `advisory finding escalates the plan gate` to `tests/subagents/policy.test.ts` or `tests/tools/spec-gate.test.ts`. Update `tests/e2e/gates-flow.test.ts` plan steps (self pass and escalated paths). Run → PASS.
- [ ] **Step 8:** `bunx tsc --noEmit && bunx vitest run` → green. Commit `feat(phase-gates): escalate the self plan gate through gate-escalation`.

---

## Task 6: Units tab behind a key — implements 6

**Covers:** 6.1
**Difficulty:** Normal
**Blocked by:** Task 2 (added: both edit `tests/interaction/dialog/host.test.ts`)

**Files:**
- Modify: `src/interaction/dialog/model.ts`, `src/interaction/dialog/state.ts`, `src/interaction/dialog/keys.ts`, `src/interaction/dialog/view.ts`
- Test: `tests/interaction/dialog/model.test.ts`, `tests/interaction/dialog/keys.test.ts`, `tests/interaction/dialog/state.test.ts`, `tests/interaction/dialog/view.test.ts`, `tests/interaction/dialog/host.test.ts`

**Interfaces:** Produces `DialogModel.unitsAvailable`, `DialogState.unitsOpen`, action `openUnits`.

- [ ] **Step 1: Failing tests**: `units tab hidden by default` (plan gate with U1/U2 → tabs `decision, review`; view of Decision contains the `u` hint); `units tab opened with one key` (`u` on Decision → tabs `decision, units, review`, current tab `units`); `u in the note editor is text`; `u at 50 columns still opens the tab`; `approve in one action` (pick recommended approve, submit, units never opened → `approved`, no overrides); update "Unit overrides on their own tab" to press `u` first.
- [ ] **Step 2:** Implement: `buildModel` sets `tabs` to decision/review and `unitsAvailable`; `state.ts` tracks `unitsOpen` and derives tabs; `keys.ts` maps `u` on Decision (no editor open) to `openUnits`; `view.ts` hint `u adjust units` when available and not open (hidden below 60 columns with the other hints). Run → PASS.
- [ ] **Step 3:** `bunx tsc --noEmit && bunx vitest run` → green. Commit `feat(approver-adapters): hide the units tab behind one key`.

---

## Task 7: Documentation — implements 7

**Covers:** 7.1
**Difficulty:** Easy
**Blocked by:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6

**Files:**
- Modify: `README.md`, `README.vi.md`, `docs/architecture.md`

- [ ] **Step 1:** Update the plan gate section (self by default; triggers; `gate: human` override; `decisions.gate-escalation`), the question section (no class, required candidates, "answer later" only), the forge command table (remove `class` and `--class`), the in-session section (units tab behind `u`), and the tool notes (briefing required on `unit_amend`, `initiative_propose`, `new_dependency`). `README.vi.md` mirrors `README.md` in Vietnamese.
- [ ] **Step 2:** `rg -n -- "--class|/livespec class|Keep classification" README.md README.vi.md docs/architecture.md` shows only the select-fallback mention of "Keep classification". Commit `docs: interaction contract, self plan gate and question class removal`.

---

## Scenario → test

Existing tests keep covering unchanged baseline scenarios; "(fixture updated)" marks tests whose requests gain a contract-valid briefing in Tasks 2 to 4.

**approver-adapters**
- Reviewer rubric cites the contract → `every rubric names the interaction contract` (Task 1)
- Approve in one action → `approve in one action` in `tests/interaction/dialog/host.test.ts` (Task 6)
- Every request kind carries a recommendation → `tests/interaction/forge-text.test.ts` `every request kind carries a recommendation` (Task 5)
- Request without a recommendation refused at construction → `prepareRequest throws without recommended` (Task 5)
- Undescribed option refused at construction → `prepareRequest throws on an undescribed option` (Task 5)
- Stored request without a briefing still answered → `reads a stored request without briefing` + existing `tests/interaction/complete.test.ts` legacy test (Task 5)
- Tool has no answer parameter → existing `tests/tools/no-answer-params.test.ts`
- Relayed approval refused, Amendment request kind, Decide request kind, Recommendation is not an answer → existing `tests/interaction/chain.test.ts`, `tests/tools/unit-amend.test.ts`, `tests/tools/decide-ask.test.ts`, `tests/tools/spec-stuck.test.ts` (fixture updated)
- Approve in the TUI, Unavailable without UI, Answer later in session, Question candidate picked in session, Own answer instead of a candidate, Empty required text in the fallback, Dialog in the TUI, Select chain in RPC mode, Fallback when the dialog draws nothing, Same answer on both paths → existing `tests/interaction/in-session.test.ts` and `tests/interaction/dialog/host.test.ts` (fixture updated; "Same answer on both paths" presses `u` in the dialog path, Task 6)
- Approve by a writer, Command without write access ignored, Command before the request ignored, Answer that changes a requirement → existing `tests/interaction/forge.test.ts`
- Answer with a class → rewritten in `tests/interaction/forge.test.ts` to expect a parse warning (Task 2)
- Class command applied once, Class command recorded across sessions, Class command already matching, Class rewrite conflict retried, Class flag rejected → `tests/interaction/poll.test.ts` / `commands.test.ts` rewritten tests (Task 2)
- Approve through Review, Review shows the answer before it is sent, No unit tab without overridable units → existing `tests/interaction/dialog/*`
- Units tab hidden by default, Units tab opened with one key → Task 6 tests
- Unit overrides on their own tab, Value set back to the current one, Overrides discarded with request changes → `tests/interaction/dialog/state.test.ts` (press `u` first, Task 6)
- Question answered in the dialog, Own answer typed in the dialog, Question without candidates → existing `tests/interaction/dialog/*` (stored legacy request fixture for the last)

**decision-seam**
- Facts from the ledger → `tests/engine/gate-escalation-facts.test.ts` (Task 5)
- Project adds a tag, No trigger, Every trigger named, Missing advisory review → `tests/decide/gate-escalation.test.ts` (Task 5)
- Rule outcome … Rule decision ignores a human record, Changed tags change the difficulty question → existing `tests/decide/seam.test.ts`, `tests/tools/decide-ask.test.ts` (test rules updated, Task 3)
- Rule ask carries descriptions → `tests/docs/behavior-change.test.ts` (Task 3)
- Rule recommends an option it does not offer → existing `tests/decide/seam.test.ts`
- Rule ask without a recommendation → Task 3 Step 4

**discovered-dependencies**
- Gate sent with default A → `new_dependency recommended A first` (Task 3)
- Split offered at the finished boundary → existing `tests/tools/new-dependency.test.ts`
- New dependency without a briefing → Task 3 Step 2

**durable-doc-checks**
- Always asks → Task 3 Step 5; Answer recorded, New file asks again → existing `tests/docs/behavior-change.test.ts`

**finding-routing**
- Unit unticked, Question raised once, Out of scope does not block → existing `tests/review/effects.test.ts`, `tests/review/stages.test.ts`
- Routing question carries candidates → Task 2 Step 3

**flow-pack**
- Default pack loads, Default pack contents, Spot check → `tests/engine/pack-load.test.ts` with updated fixture (Task 5)
- Replace one key → `tests/engine/pack-load.test.ts` override `gate: human` (Task 5)
- Replace a skills list, Add a phase, Merge loops, Error points at override, Decisions merge through the rule → existing `tests/engine/pack-load.test.ts`

**phase-gates**
- Plan without triggers passes alone, Waived size limit asks the human, Security unit asks the human, Critical advisory finding asks the human, Escalated gate without a briefing, Project keeps a human plan gate, Unlisted self gate unchanged → Task 5 Step 4
- Next step names the escalation → Task 5 Step 6
- Gate tool scenarios (Blocking question … Approve not recommended while a check must be waived) → existing `tests/tools/spec-gate.test.ts`, `tests/tools/spec-gate-behavior.test.ts` (plan-gate fixtures switch to a project `gate: human` or a trigger, Task 5)
- Proposer briefing → `initiative_propose without a briefing` (Task 3)
- Waive at the gate, Waived ship gate stays in ship, Approve without waiving → existing `tests/tools/spec-gate.test.ts`, `tests/interaction/forge.test.ts`

**questions-and-stuck**
- Blocking by default, Non-blocking proposal, Question without candidates refused, Reask needs candidates → Task 2 Step 1
- Candidate answers sent, Too many candidates, Candidate label that cannot round-trip → existing `tests/tools/question-candidates.test.ts`
- Answer written back → existing `tests/interaction/complete.test.ts`; Human reclassifies → `answer later defers as non-blocking` (Task 2 Step 6)
- Stuck report waits for a choice, Option count enforced, Choice recorded, Option without a description → existing `tests/tools/spec-stuck.test.ts`; Old stuck report sent again → Task 3 Step 3

**request-briefing**
- Recommended choice not offered, Rationale missing, Summary too long → existing `tests/interaction/briefing.test.ts`; Recommendation missing → Task 3 Step 1
- Gate comment structure, Question candidates as commands, Prefilled answer parses back → existing `tests/interaction/forge-text.test.ts`; Recommended row first → Task 1 Step 5

**subagent-policy**
- Advisory spec review → existing `tests/subagents/policy.test.ts`; Advisory finding escalates the plan gate → Task 5 Step 7

**unit-planning**
- Amendment unfreezes … Amendment with a briefing → existing `tests/tools/unit-amend.test.ts` (fixture updated)
- Amendment without a briefing → Task 3 Step 1
