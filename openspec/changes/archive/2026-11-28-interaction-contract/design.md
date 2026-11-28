## Context

Every human request is built by one of five builders that all call `prepareRequest` (`src/interaction/requests.ts`): `gateRequest` (`src/tools/spec-gate.ts`), `amendRequest` (`src/tools/unit-amend.ts`), `questionRequest` (`src/tools/spec-question.ts`), `stuckRequest` (`src/tools/spec-stuck.ts`) and `decisionRequest` (`src/tools/decide-ask.ts`). The briefing is optional in each. Proposer gates (`initiative_propose`, `new_dependency`) reuse `gateRequest` through `sendNamedGate`. Option descriptions are optional except for stuck options and question candidates; the built-in gate actions get livespec descriptions from `src/interaction/describe-actions.ts`.

`planGate` refuses a `self` phase gate when a waivable check fails. The plan phase has `gate: human` in `src/packs/agent-skills.yaml`. The question class lives in the `## Questions` line, the `spec_question` `class` parameter, `Deferred.questionClass`, `Answered.questionClass`, the `--class` flag and the `class` command (`src/interaction/commands.ts`, `forge-match.ts`, `poll.ts`). The dialog model sets `tabs` to include `units` whenever `overridable` is set (`src/interaction/dialog/model.ts`).

## Goals / Non-Goals

**Goals:**
- One construction-time guard enforces "recommended plus rationale" and "every option described" for all request kinds.
- The plan gate becomes self unless a recorded rule decides to escalate.
- The question class becomes code-owned: human and agent choices removed, stored data still read.
- The units tab is hidden until asked for.

**Non-Goals:**
- Changing how account selection asks.
- Changing what the `behavior-change` question asks (#64). The requirement cascade was already moved to the spec diff by #73, so questions carry no requirement step.
- Migrating stored requests, `class` markers or `## Questions` lines.

## Decisions

### D1. The guard lives in `prepareRequest`
`prepareRequest` gains `assertContract(input)`. It throws a programming error (`Error`, not a tool refusal) when the briefing is missing, `recommended` or `rationale` is missing, `recommended` is not an offered choice, or an offered option has no description. It is the single entry point every builder already uses, so one check covers every kind; a throw (rather than a refusal) is right because each tool validates its own parameters first and names the field. Reaching the guard means a builder bug. Offered choices come from `offeredChoiceIds`, so built-in gate actions count as described (livespec writes their descriptions). Alternative: validate in each builder. Rejected, because a sixth builder could skip it.

### D2. Tools require the fields before anything is written
Each tool keeps refusing by field name, before checks or writes:
- `spec_gate` already requires the briefing on human gates. When the gate escalates (D4), the same briefing rule applies, checked after escalation is decided. A `self` phase gate that may escalate therefore requires `briefing` only when it escalates, and refuses then without sending, naming `briefing`.
- `unit_amend`, `initiative_propose` and `new_dependency`: `briefing` with `recommended` and `rationale` required.
- `spec_question`: `candidates` (2 to 4), `recommended` and `rationale` required, on a new question and on `reask`.
- `spec_stuck`: unchanged (already strict). A stored legacy report is resent with briefing `{ summary: hypothesis, recommended, rationale }`, author `agent`, where `rationale` is the stored one or `Recommended in stuck report S<n>.`; options without a description get `Option <id> of stuck report S<n>.`
- `NEW_DEPENDENCY_OPTIONS` get descriptions and lose the `(default)` label text; the recommended option is listed first by the presenters as for every request.

### D3. Rule asks must recommend
`checkRuleAsk` in `src/decide/seam.ts` throws when an ask has no `recommended` or no `rationale`, or an option without a description. `behaviorChangeRule` recommends `unchanged` with the rationale "Code under the capability's paths changed but its spec did not; most such edits are refactors." The finding-routing question passes the candidates `apply the proposed fix` (recommended) and `leave it out of this change`, with the descriptions and rationale finding-routing "Route effects" fixes; they get the ids `A` and `B` like any candidate. Either answer resolves the finding as today. Labels pass `labelProblem`. The `behavior-change` recommendation is static, a known limitation until #64 replaces the question.

### D4. `gate-escalation` rule
New rule in `src/decide/rules/gate-escalation.ts`, registered in `registerBuiltinRules`, config `decisions.gate-escalation: { mode: rule, phases: [plan], tags: [security, migration] }`. Its schema validates `phases` and `tags` as string lists and registers a merge that replaces each list a project override sets. Facts are built by code in `src/engine/gate-escalation-facts.ts`:
- `phase`;
- `failing_waivable`: from `failingWaivable`;
- `advisory_review`: `missing` when the phase has an `always` advisory reviewer entry and no completed review at HEAD (`changeReviewDoneAt`), otherwise `critical` when that review's `finding-summary` holds a `CRITICAL` finding, otherwise `clean`, or `none` when the phase has no advisory reviewer;
- `units`: each unit's id and tags.

The rule returns outcome `human` with a reason naming every trigger that holds, or `self` with the reason "no trigger". It never asks. Only phases in `phases` with `gate: self` consult it, so `shape` and `review` keep their self gates. `spec_gate` records it as `decision` `gate-escalation.<phase>` with `head_sha` in the facts. `planGate` takes the outcome: on `human` it returns the human plan (waive offered, overridable units), on `self` the current self plan.

Order inside `spec_gate`: checks and refusals, then the pure rule; on `human` the briefing is validated before anything is written, so a refusal writes nothing. Then the `decision` record is posted unless the latest `gate-escalation.<phase>` record has the same facts (a rerun posts nothing new), and the gate passes or is requested.

The next step forecasts without a write. `gateReady` in `src/engine/gate-decision.ts` calls the same `gateEscalationFacts` and pure rule over the check results it has (gate-only checks such as `verify-red-on-base` are not run there, so the gate may still escalate on them). It says "the plan gate will ask the human (reasons); pass a briefing", and names the advisory reviewer dispatch first when the review is missing. The record is evidence, written by `spec_gate` only.

Alternative: `gate: auto` (rejected in brainstorm.md).

### D5. Question class
- `spec_question` drops the `class` parameter from its schema. Tool code still sets `non-blocking` through an internal option `{ origin: "routing" }` of `runSpecQuestion`, which `src/review/stages.ts` passes. A tool call with `class` is refused: "`class` was removed; questions are blocking until the human chooses answer later."
- `parseAnswer` returns an error for `--class`; `parseCommand` reports `class` as an unknown command. Unknown commands already produce a card warning.
- `Answered.questionClass` is removed from new answers; `complete-question.ts` takes the class from the `## Questions` line, or `non-blocking` for a deferred answer (`Deferred` keeps its `questionClass: "non-blocking"`, since that is the "answer later" effect).
- `poll.ts` stops applying `class` commands; stored `class` markers are ignored. `forge-match.ts` drops `ClassChange`.

### D6. Units tab behind a key
`buildModel` sets `tabs` to `["decision", "review"]` always and `unitsAvailable: true` when `overridable` is set. Key `u` on the Decision tab adds the `units` tab between them and switches to it; Tab then cycles all three. The Decision tab footer shows `u adjust units` when available. The select fallback already asks "Keep classification" first, which is one action, so it stays. Overrides, their Review display and their discard rule are unchanged.

### D7. Recommended row first on the forge
`forge-text.ts` sorts the "How to answer" rows so the recommended row comes first, after which the remaining choices keep their order; the free-text row of a question stays last.

### D8. Reviewer rubrics cite the contract
`rubricFor` appends to every rubric, persona subjects included: "A new or changed human request that breaks approver-adapters \"Interaction contract\" is a finding." One sentence, shared constant.

## Risks / Trade-offs

- [No subagent executor] → an inline plan review recorded with `subagent_record` counts as completed, so the plan gate can still stay self.
- [Scenario names kept for archive] → OpenSpec refuses renaming scenarios inside MODIFIED blocks, so the `class` scenarios and "Human reclassifies" keep old names with new content.
- [Agents calling the old tool shapes get refusals] → each refusal names the missing field and its shape; tool descriptions are updated.
- [A plan escalated in session but answered later on the forge] → the gate request is a normal human request; completion is unchanged.
- [Rule facts drift between `gateReady` and `spec_gate`] → both call one `gateEscalationFacts(state, pack, phase)` and the pure rule.
- [Stored pending questions with a `class` from the agent] → still read from the `## Questions` line; nothing rewrites them.
- [Forge-only chains cannot defer a question] → accepted: the question stays blocking until answered; a web edit of the marker still works.
- [Removing `/livespec class` breaks a habit] → the card warning names the command as unknown; README lists the change.

## Migration Plan

No data migration. Stored requests without a briefing, stored `class` markers and answers with `questionClass` stay readable. The pack fixture `tests/fixtures/agent-skills.pack.json` gains `gate-escalation` and `plan` `gate: self`. Rollback: projects set `phases: { plan: { gate: human } }` in `.pi/livespec/flow.yaml`.

## Open Questions

None.
