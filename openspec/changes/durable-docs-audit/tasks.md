## 1. Product impact and glossary checks

Blocked by: none

- [x] 1.1 Add `src/docs/product-impact.ts`: pure `productImpactResults(change)` per durable-doc-checks "Product impact check" (missing, `—`, invalid, `none` with a `new` capability), with tests in `tests/docs/product-impact.test.ts`
- [x] 1.2 Add `src/docs/glossary-terms.ts`: pure `glossaryCandidates(addedLines, glossary, knownText)` (bold terms minus scenario keywords, capitalized non-initial words outside backticks unknown at `Base`, match ignoring case and a trailing `s`) and the `glossary-terms` check over `git diff <Base>..HEAD -- specs/`, warnings only; tests in `tests/docs/glossary-terms.test.ts`
- [x] 1.3 Register both checks from `src/docs/register.ts`, called by `registerBuiltinChecks` in `src/engine/checks.ts`; add the define gate payload "Glossary" section (warnings plus entries the specs diff adds to `specs/glossary.md`) through `registerGatePayload("define", …)`; test the payload in `tests/docs/glossary-terms.test.ts`

## 2. Behavior change rule, check and gate question

Blocked by: 1

- [x] 2.1 Add `src/docs/behavior-change.ts`: `behaviorFacts(diffFiles, specs)` per "Behavior change facts", `behaviorDigest(files)`, the always-asking rule with options `unchanged`/`changed` and its schema; register it in `registerBuiltinRules` (`src/decide/registry.ts`); keep a top-level `files` on `behavior-change` records through `DecisionSnapshot`/`applyDecide` and `compactFacts` (`src/decide/records.ts`, `src/interaction/complete-decide.ts`); tests in `tests/docs/behavior-change.test.ts` and `tests/decide/records.test.ts` ("Behavior files kept with hashed facts")
- [x] 2.2 Add the `behavior-change` check (errors for no record naming `spec_gate <phase>` or the open request, for a `changed` record; nothing for `unchanged`), reading reusable records with `reusableAnswer` from `ctx.marked`; register it from `src/docs/register.ts`
- [x] 2.3 In `src/tools/spec-gate.ts`, for targets `define` and `review`: run checks and `gateRefusal` with `behavior-change` results filtered out and return any refusal before writing; then `askBehaviorChanges(w, state, ctx)` runs `decide("behavior-change", …)` with `createDecisionAsker` per item without a reusable record (refuse naming a pending request); then refresh and run the full checks and refusals before the gate request
- [x] 2.4 Tests in `tests/tools/spec-gate-behavior.test.ts`: in-session answer recorded then gate request sent; other refusal (dirty tree, blocking question, `spec-format` error) asks and writes nothing; `changed` answer refuses in the same call; forge pending refuses; reused record asks nothing

## 3. Ship reads the behavior record

Blocked by: 2

- [x] 3.1 Extend `DurableFacts` in `src/ship/durable-docs.ts` with `behavior` (per capability the latest human `behavior-change` record) and skip a capability confirmation when that record is `unchanged` and its files are a superset of the capability's changed files
- [x] 3.2 Build `behavior` in `src/ship/context.ts` from the change state's marked comments; tests for "Behavior answered earlier", "Record misses a file", "Newer changed record wins" and "Superset record" in `tests/ship/durable-docs.test.ts`, keeping the existing scenarios green

## 4. Packet readers

Blocked by: none

- [x] 4.1 Make `SourceProvider` accept an optional `Target` second argument (`src/subagents/source-types.ts`, `registered()` in `src/subagents/sources.ts`)
- [x] 4.2 Add `src/docs/readers.ts`: glossary entries matching the unit text or `## Units` section (`file:specs/glossary.md`, omitted when none match), accepted `spine: true` decisions and accepted decisions tagged with a declared capability (`file:specs/decisions/<file>`), registered for `implementer` and `reviewer` with `registerPacketSource`; registration called from the extension entry
- [x] 4.3 Add the existing `constraints` provider to the reviewer manifests in `src/subagents/sources.ts`
- [x] 4.4 Tests in `tests/docs/readers.test.ts` and `tests/subagents/sources.test.ts` for "Glossary entries for the unit", "Spine and capability decisions" and "Reviewer sees constraints"

## 5. Pack, fixture and scout schema

Blocked by: 1, 2, 6

- [x] 5.1 Update `src/packs/agent-skills.yaml`: `define` checks gain `product-impact`, `glossary-terms`, `behavior-change`; `review` checks become `[product-impact, glossary-terms, behavior-change, review-clean]`; `decisions` gains `behavior-change: { mode: rule }` and `drift-severity: { mode: rule }` (both rules are registered by groups 2 and 6; an unregistered point fails pack validation)
- [x] 5.2 Update `tests/fixtures/agent-skills.pack.json` and the spot check in the pack tests
- [x] 5.3 Add optional `verdicts` to the scout result schema in `src/subagents/roles.ts`; test "Scout verdicts accepted" in `tests/subagents/roles.test.ts`

## 6. Drift detectors and severity

Blocked by: 2

- [x] 6.1 Add `src/audit/repo-view.ts` (files of a commit via `git ls-tree -r` and a reader via `git show <commit>:<path>`, plus an in-memory view for tests) and the `DriftItem` type (`type`, `key`, `subject`, `capability?`, `evidence`, `confirmed?`)
- [x] 6.2 Add pure detectors (`declared-none` finds fix pull requests from the subjects of first-parent commits of `<fixCursor>..<audited commit>`, sharing the subject parser with 8.2): `src/audit/detect-specs.ts` (`scenario-untested`, `removed-reference`, `dead-paths`), `src/audit/detect-docs.ts` (`unused-term`, `stale-decision`, `product-missing`) and `src/audit/detect-fixes.ts` (`declared-none` from merged `fix/*` pull requests and their `lane` decision blocks via `parseDecisionBlocks`)
- [x] 6.3 Add `src/audit/severity.ts`: `severityFacts(item, kept)` (`{ type, capabilityHasMajor }`), the `drift-severity` rule and schema, registered in `registerBuiltinRules`
- [x] 6.4 Seeded fixture repository in `tests/audit/seeded.ts` and tests in `tests/audit/detect.test.ts` and `tests/audit/severity.test.ts` covering every drift-detectors and drift-severity scenario

## 7. Audit command, scout, report and triage

Blocked by: 4, 5, 6

- [x] 7.1 Add `src/audit/confirm.ts`: build the audit scout packet (protocol, no flow skills, task with untrusted evidence of `scenario-untested` and `removed-reference` items), dispatch through `runDispatch` with a sink `post`, thinking `low`, `cwd` a `withTempWorktree` of the audited commit and metadata `change: audit`; interpret `verdicts`; keep items unconfirmed without an executor, with the agent disabled, on a launch mismatch or an invalid result; never inline
- [x] 7.2 Add `src/audit/report.ts` (render, `drift-report` marker kind via `registerKind`, post on the target initiative or print, with the reason when printing only) and `src/audit/triage.ts` (read `/livespec triage` commands, permission check, latest per key)
- [x] 7.3 Add `src/commands/audit.ts` (`runAudit`: fetch, resolve the audited commit `origin/<integration>` with the local-ref fallback and the no-ref refusal, detect, confirm, classify, triage, report) and route `audit` in `src/extension.ts` and `src/commands/subcommands.ts`, updating `USAGE` and the command description
- [x] 7.4 Tests in `tests/audit/confirm.test.ts`, `tests/audit/report.test.ts`, `tests/audit/triage.test.ts` and `tests/commands/audit.test.ts` (read-only working tree, integration snapshot not the feature branch, fetch fails with a local ref, no integration ref, scout sees the audited snapshot, audit scout launch, forge unavailable skips `declared-none`, seeded audit with a confirming fake scout, not initialized, posted on initiative, printed without one, usage lists `audit`)

## 8. Audit suggestions

Blocked by: 7

- [ ] 8.1 Add `src/audit/state.ts`: read and write `<git common dir>/livespec/audit.json` atomically (temp file and rename)
- [ ] 8.2 Add `src/audit/suggest.ts`: on `livespec:initiative-closed` add an initiative suggestion; at `session_start` check the oldest 50 first-parent commits of `<cursor>..origin/<integration>` (no fetch), classify livespec commits through the pull request head branch, add commit suggestions for manual commits under a capability's `paths`, move the cursor to the last commit checked; first run only sets the cursor; forge errors keep it
- [ ] 8.3 Add the "Audit" card section in `src/audit/card.ts` via `registerCardSection`; hook the event listener and the `session_start` step in `src/hooks/session.ts`; a completed audit clears the covered commit suggestions and the initiative it posted on, records the audited commit, and sets the fix cursor only when `declared-none` ran to the end
- [ ] 8.4 Tests in `tests/audit/suggest.test.ts` and an e2e test `tests/e2e/audit-flow.test.ts` (manual commit suggests an audit; livespec merge not suggested; more than 50 commits; initiative closed then audit posts on it; audit clears only covered suggestions; skipped fix detector keeps the fix cursor; fix merged during the audit)

## 9. Durable documentation

Blocked by: 3, 4, 8

- [ ] 9.1 Update `docs/architecture.md`: module list (`docs/`, `audit/`), a "Durable docs" section (checks, behavior question, readers, ship reuse) and an "Audit" section (detectors, scout, severity, report, triage, suggestions)
- [ ] 9.2 Add `Drift report` to `docs/glossary.md`; run `bun run typecheck` and `bun run test`
