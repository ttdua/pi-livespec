## Why

Review is the step agents skip or soften most often. Today livespec has a finding schema, unit reviews and advisory spec and plan reviews, but its `review` phase is an empty `self` gate: nothing fans out independent reviewers over the whole change, nothing checks that a blocking finding is real, and a finding has no route back into the work. LS-08 (issue #8) builds that phase so a change reaches `ship` only after an independent, multi-lens review whose blocking findings were fixed, refuted, or routed elsewhere.

## What Changes

- **`spec_review`**, a new parent tool that runs one review round of the whole change: it re-checks tags on the actual diff, selects the reviewers, runs the `constraints-not-weakened` check and every unit's `Verify` at HEAD, fans the reviewers out in parallel (or returns their packets for inline review), de-duplicates their findings into one aggregate record, sends each blocking finding to the `verifier`, and routes every finding. It is re-entrant: each stage is derived from forge records, so an interrupted or inline round resumes where it stopped.
- **Personas.** The change reviewer (`code-reviewer`) always runs; `security-auditor`, `web-performance-auditor` and `test-engineer` run on `tags:security`, `tags:perf`/`tags:ui` and `units>=3`. They are `review` phase entries of the default pack, and each persona's agent-skills `agents/<name>.md` reaches its reviewer as a packet source.
- **Tags re-checked at review** against `git diff <Base>..HEAD`; new tags are recorded in one decision record and still add their persona. Unit bodies do not change.
- **`constraints-not-weakened`**, a deterministic check that turns added skip/only markers, unexplained `@ts-ignore`/`@ts-expect-error`, `eslint-disable`, deleted test files and removed assertions into `CRITICAL` `lowered-standard` findings.
- **Verifier.** The `verifier` role receives one aggregate finding and returns a `verdict`. A refuted finding becomes `DISPUTED` and does not block; a verifier that fails leaves the finding blocking. `missed-context` findings and the parent's deterministic findings skip the verifier.
- **Routing** through `decide("finding-scope")` from the finding's location, never the reviewer's `scope`: `unit` (untick and rebuild; the change returns to `build`), `in-change` (next step `unit_amend --add`), `out-of-scope` (non-blocking follow-up), `needs-decision` (`spec_question`), `SUGGESTION` (recorded only). `routeFinding` is exported for LS-09.
- **Posting.** The aggregate is a `finding-summary` on the issue; when a pull request exists, findings are also posted as its review comments.
- **Rounds and gate.** `review_rounds` (default 3) counts completed rounds, derived from records; reaching it with a blocking finding left makes the next step `spec_stuck`. `spec_gate review` passes only when the latest completed round reviewed HEAD and left nothing blocking; its `head_sha` is that commit.
- **`code-simplification`.** When the agent used the skill in `review`, the next step before the last round suggests a `simplify` unit through `unit_amend --add`, which must be `Kind: refactor`.

## Capabilities

### New Capabilities
- `review-phase`: `spec_review` and its stages, reviewer selection with personas and tag re-check, the `constraints-not-weakened` check, `Verify` of every unit at HEAD, the `review_rounds` cap, the review gate's pass condition, the return to `build`, and the `simplify` unit.
- `finding-routing`: the aggregate record and de-duplication, verification and `DISPUTED`, the `finding-scope` rule and `routeFinding`, the effects of each route, and pull request review comments.

### Modified Capabilities
- `review-findings`: a `DISPUTED` finding does not block; an aggregate's computed route replaces the reviewer's `scope` for blocking and resolution.
- `subagent-dispatch`: the `verifier` role takes a finding reference on the dispatch, packet and record tools, and its result requires a `verdict`.
- `subagent-packets`: the `verifier` manifest is built from the referenced aggregate finding; a `persona:<name>` and `change` reviewer packet holds the persona's agent file.
- `subagent-policy`: the default pack declares `review` phase entries; `review` phase entries are run by `spec_review`, not suggested one by one.
- `flow-engine`: next-step precedence gains the review round, the `review_rounds` stuck step and the return to `build`; `review_rounds` is a derived counter.
- `flow-pack`: the default pack's `review` phase gains its `subagents` entries and the `review-clean` check.
- `unit-evidence`: `unit_start` accepts a green `Verify` at pre for a unit a review finding routed back (a rebuild), recorded with verdict `rebuild`.
- `unit-planning`: `unit_amend` refuses a unit titled `simplify` that is not `Kind: refactor`.

## Impact

- **New code:** `src/review/` (round orchestration, selection, tag re-check, standards check, aggregate, verification, routing), `src/tools/spec-review.ts`, a `finding-scope` rule in `src/decide/rules/`.
- **Changed code:** `src/subagents/roles.ts`, `sources.ts`, `sources-git.ts`, `records.ts`, `payload.ts`, `phase-entries.ts`; `src/tools/subagent-target.ts`, `subagent-dispatch.ts`, `subagent-packet.ts`, `subagent-record.ts`; `src/engine/next-step.ts`, `counters.ts`; `src/tools/unit-amend.ts`, `src/tools/unit-start.ts`, `src/evidence/refusals.ts`; `src/packs/agent-skills.yaml` and its canonical fixture.
- **Runtime:** the same optional executor service as LS-07; without it every reviewer and verifier runs inline.
- **Docs:** `docs/architecture.md` gains a Review section.
