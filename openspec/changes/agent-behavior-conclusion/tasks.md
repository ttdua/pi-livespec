## 1. Conclusion records and precedence (core)

Blocked by: none

- [x] 1.1 Widen `DecisionRecord.source` in `src/decide/records.ts` to `rule | human | agent | reviewer`; `validDecisions` accepts `agent`/`reviewer` only for point `behavior-change` (decision-seam "Decision records", scenario "Agent source only for behavior-change"); `reusableAnswer` still requires `human`
- [x] 1.2 In `src/docs/behavior-change.ts`, add a `BehaviorConclusion` type, the pure resolver `effectiveConclusion(marked, item)` (digest+facts candidates plus intersecting human/reviewer `changed`, rank ordering) and `latestConclusions(marked)` over all digests (durable-doc-checks "Behavior conclusion precedence", all scenarios); remove `latestBehaviorRecords`
- [x] 1.3 Make `behaviorChangeRule` return outcome `null` with a reason naming `spec_gate` `behavior`; drop `BEHAVIOR_OPTIONS`/`BEHAVIOR_RATIONALE` (durable-doc-checks "Behavior conclusion rule", scenario "Rule never asks"); keep `registerRule` and the schema
- [x] 1.4 Rewrite `behaviorResults` over `effectiveConclusion`: no conclusion → error naming `behavior` and `spec_gate <phase>`, plus any open legacy request; `changed` → error naming the spec file and source (durable-doc-checks "Behavior conclusion check")
- [x] 1.5 Add `behaviorConclusionComment(item, { source, outcome, reason, overridden_by? })` building the full `decision` comment (facts, digest, files) for reuse by groups 2, 4 and 5
- [x] 1.6 Update `tests/docs/behavior-change.test.ts` and `tests/decide/records.test.ts` for the scenarios above

## 2. spec_gate behavior parameter

Blocked by: 1

- [x] 2.1 Add `validateBehaviorParam(raw)` (shape, 300 code points, one line, neutralised rationale) in a new `src/docs/behavior-param.ts`; wire it into `runSpecGate` beside `briefingStep` for every target (durable-doc-checks "Behavior conclusion parameter"; phase-gates scenario "Bad behavior shape on another target")
- [x] 2.2 Add the `behavior` JSON schema and description to `spec_gate` in `src/tools/spec-gate.ts`
- [x] 2.3 Replace `askBehaviorChanges` with `recordBehaviorConclusions(w, state, behavior)`: coverage check (missing or extra capabilities named), skip-equal against the latest agent record, posting `agent` records; keep `behaviorStep` ordering (refusals without `behavior-change` first, refresh, re-run) (durable-doc-checks "Behavior conclusion at the gate", all scenarios; phase-gates "Gate tool" scenario "Behavior answer before a refusal")
- [x] 2.4 Delete `src/docs/behavior-ask.ts` and the `BEHAVIOR_POINT` branch in `src/tools/decide-ask.ts` that only fed asks (keep reading legacy pending requests)
- [x] 2.5 Rewrite `tests/tools/spec-gate-behavior.test.ts` for the new flow (two capabilities with no dialog, missing or unknown capability, other refusal writes nothing, changed blocks, not re-posted, flow without the check)

## 3. Gate payload and forge text

Blocked by: 1, 2

- [x] 3.1 Compute the behavior items once in `buildRequest` and pass them as `ReviewFacts.behaviorItems` (`src/engine/gate-payload.ts`, `src/tools/spec-gate.ts`); in `src/docs/register.ts`, add the define payload section "Behavior conclusions (please check)" from `effectiveConclusion`, with neutralised rationale; no section without items (phase-gates "Gate review payload" scenarios "Behavior conclusions listed", "No behavior section without items")
- [x] 3.2 Tests in `tests/docs/` for the payload section

## 4. Ship durable docs

Blocked by: 1

- [x] 4.1 Switch `src/ship/context.ts` `behaviorFacts` to `latestConclusions`; update the `DurableFacts["behavior"]` doc comment in `src/ship/durable-docs.ts` (ship-phase "Durable docs rule and check", scenarios "Agent conclusion covers the files", "Newer changed record wins", "Protected change of other files")
- [x] 4.2 Update `tests/ship/context.test.ts` and the durable-docs tests

## 5. Human behavior override

Blocked by: 1, 2, 3

- [x] 5.1 Add `BehaviorOverride`, `Answered.behaviorOverrides`, the stored `GateSnapshot.behavior` and the derived `ApprovalRequest.overridableBehavior` in `src/interaction/approver.ts`; set the snapshot on `gate:define` requests in `buildRequest` (`src/tools/spec-gate.ts`) when items exist
- [x] 5.2 (Superseded by 8.3: the forge override was removed when rebasing onto LS-12a; LS-12c owns forge answers.) Forge: parse `set behavior <capability> changed` in `src/interaction/commands.ts`; collect in a new `src/interaction/forge-behavior.ts` called from `forge-match.ts`, attach only to `changes`, warn on approve or other outcomes, an unknown capability, a value other than `changed`, or a non-define request; list the command in `src/interaction/forge-text.ts` `<details>` (approver-adapters "Forge command comments", "Behavior overrides"; request-briefing "Forge request text")
- [x] 5.3 Dialog: `b` key hint and Behavior tab in `src/interaction/dialog/{model,state,keys,view,result}.ts`; the Review tab shows overrides or marks them discarded (approver-adapters "In-session dialog", "Behavior overrides")
- [x] 5.4 `select` fallback: an optional "Mark behavior changed" step after request changes in `src/interaction/in-session.ts`
- [x] 5.5 Completion: `applyBehaviorOverrides(run, answer, snapshot)` in a new `src/interaction/complete-behavior.ts`, idempotent by `overridden_by`, called from `src/interaction/complete-gate.ts` when not superseded and `changes_requested`, before the stale and gate comments (durable-doc-checks "Human behavior override")
- [x] 5.6 Tests under `tests/interaction/` for commands, forge-match, dialog, in-session and completion

## 6. Reviewer conclusions

Blocked by: 1

- [x] 6.1 Add the optional `behavior` array to the reviewer result schema in `src/subagents/roles.ts` (subagent-dispatch "Return contract")
- [x] 6.2 Add the required source `records:behavior-conclusions` for `change` reviewer packets through a provider in `src/docs/behavior-source.ts` registered from `src/docs/readers.ts`, left out without items; carry the items and effective conclusions on `Packet.behavior` (subagent-packets "Context manifest"; durable-doc-checks "Behavior conclusions in the reviewer packet")
- [x] 6.3 Result validation: a `changed` dispute without a blocking finding at the item's files returns once (separate counter), then drops with a note (`src/subagents/result.ts`, `dispatch.ts`)
- [x] 6.4 After the `finding-summary` of a completed non-advisory `change` run, post `reviewer` records for entries whose outcome differs, ignoring unknown capabilities (`src/docs/behavior-review.ts`, called from `dispatch.ts` `finish` and `tools/subagent-record.ts`)
- [x] 6.5 Tests under `tests/subagents/` for the schema, packet, return-once and records

## 7. Docs and final verification

Blocked by: 2, 3, 4, 5, 6

- [x] 7.1 Update the README "Behavior-change question" paragraph (define gate section) and `README.vi.md`, plus `docs/architecture.md` mentions, to describe agent conclusions and the override
- [x] 7.2 Add a CHANGELOG entry
- [x] 7.3 Run `bun run typecheck` and `bun run test`; all green

## 8. Port onto ledger-store (LS-12a)

Blocked by: 7

- [x] 8.1 Port record writes to the ledger: `behaviorConclusionComment` returns an `AppendInput` (like `decisionComment` on main); `recordBehaviorConclusions`, `recordReviewerConclusions`/replay and `applyBehaviorOverrides` append through the ledger (`appendRecord`, `RecordDeps.record`); `BehaviorConclusion.commentId` becomes `ref`, and `validDecisionEntries` returns `{ record, ref }`
- [x] 8.2 `isBacked` (`src/decide/answered.ts`): a ledger `human` `behavior-change` entry with `overridden_by` counts only when the own forge `answer` of its `request` is valid, `changes_requested`, and lists the capability in `behaviorOverrides`; `applyBehaviorOverrides` writes `request`; `effectiveConclusion`/`latestConclusions` skip unbacked human entries (durable-doc-checks "Human behavior override", scenario "Override without its forge answer")
- [x] 8.3 Remove the forge override: drop `set-behavior` from `src/interaction/commands.ts`, delete `src/interaction/forge-behavior.ts` and its calls in `forge-match.ts`, drop the `<details>` line in `forge-text.ts`, and remove or rewrite their tests (approver-adapters "Behavior overrides", scenario "No override on the forge")
- [x] 8.4 Port the tests to the ledger harness of main (`tests/helpers/ledger.ts`, `ledgerRecord`, `appendSeed`): fix the typecheck errors and rewrite the spec-gate-behavior, behavior-payload, records, sources, dispatch and subagent-record tests that seed or read decision comments
- [x] 8.5 Update README, README.vi, docs/architecture.md and CHANGELOG: records are ledger entries, overrides are in session only
- [x] 8.6 Run `bun run typecheck`, `bunx vitest run` and `openspec validate agent-behavior-conclusion`; all green

