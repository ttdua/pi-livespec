## Why

Work bigger than one change today is either packed into one pull request or split by hand with nothing enforcing the order, and a prerequisite found mid-build can only go to `spec_stuck`, which leaves in-progress lanes stranded. LS-09c (#34, part 3 of LS-09 #9) adds initiatives with a human-approved `Depends` order, readiness checks before a change starts, size limits with split, and a park-and-resume path that loses no work.

## What Changes

- **`initiative_propose`** (rule `split` suggests it): from a change in `shape`, the agent lists changes (name, short Proposal, `Depends` by name). The named gate `initiative` (a human decides, `source: human`) approves it; completion creates the tracking issue (label `livespec:initiative`) and every other change issue, and the shaping change becomes the first entry. The tracking body list is the only source of truth.
- **Readiness**: a change is ready when every dependency has merged (its issue is closed and the forge reports its pull request merged; an abandoned change never counts). `change_start` refuses otherwise. A `Depends` cycle is rejected wherever `Depends` are written.
- **Initiative card**: the phase card and the open-changes list show initiative progress and the ready changes; a human runs each `change_start`.
- **Parallel changes**: once a sibling of the same initiative merged, the next step names `change_sync`, which merges the integration branch in, moves `Base`, re-runs every finished unit's `Verify` as a `regression` record and makes failing or affected units stale; a conflicted merge goes back to review. A card warning names other open changes that declare the same capability.
- **`size-limits`**: a waivable plan check over the pack's `limits.max_units` and `limits.max_capabilities`.
- **`change_split #N --units … --into <name>`**: moves unbuilt units into a new change issue in the same initiative and reopens the plan gate of both.
- **`new_dependency`** opens the `new-dependency` gate with drafted options A (default) to D, plus `split` when finished units stand on their own; it follows a `missing-prerequisite` result or a parent finding.
- **`change_park`**: commits every in-progress unit's work to `livespec/<change>--wip-<unit>`, pushes it through `guardedPush`, labels the issue `livespec:parked` and posts a `parked` record. **`change_resume #N`**: once the prerequisite merged, merges the integration branch in, restores the wip work, re-runs `Verify` of every finished unit as a `regression` record, merges each wip branch back, and lifts the park.
- **`discovered_deps`** counter (pack cap 2): past it the next step asks for `spec_stuck`.

**Change start**
- From: `change_start` refuses only on a dirty tree, a non-change issue or an existing `Branch`.
- To: it also refuses while a `Depends` change has not merged, or while the change is parked.
- Reason: change B must not start before A merges.
- Impact: behavior change for changes with `Depends`; changes without `Depends` are unaffected.

**Missing prerequisite**
- From: `BLOCKED` with reason `missing-prerequisite` goes to `spec_stuck`.
- To: it names the `new-dependency` gate, and `spec_stuck` only when `discovered_deps` is at its cap.
- Reason: the dependency gate now exists.
- Impact: non-breaking for other `BLOCKED` reasons.

**Guarded push**
- From: only `change_ship`, `change_push` and `fix_ship` call `guardedPush`.
- To: `change_park` is a fourth caller, pushing only `HEAD:refs/heads/livespec/<change>--wip-<unit>` from each wip commit.
- Reason: parked work must be reachable from any session.
- Impact: non-breaking; the guard still blocks every agent `git push`.

## Capabilities

### New Capabilities
- `change-initiatives`: `initiative_propose`, the `split` rule, the `initiative` gate and its completion (creating the change issues with `Initiative`, `Depends` and a short Proposal; `change_new` itself is unchanged), amendments of an initiative, readiness and `Depends` cycles, the initiative card lines, the capability overlap warning, `change_sync` and the `regression` record, `size-limits` and `change_split`.
- `discovered-dependencies`: `new_dependency` and the `new-dependency` gate with its options, `change_park`, the `parked` record, `change_resume`, and the derived `discovered_deps` counter.

### Modified Capabilities
- `change-tools`: "Change start refusals" adds unmerged `Depends` and parked changes.
- `subagent-dispatch`: "Result handling" sends `missing-prerequisite` to the `new-dependency` gate.
- `command-guards`: "Guarded push" gains `change_park` as a caller.
- `context-injection`: "Phase card content" shows initiative progress, ready changes and the parked state.
- `flow-engine`: "Next step precedence" adds unmet `Depends` before start, the parked state, the follow-up of a `new-dependency` choice and the `change_sync` step; "Loop counters" derives `discovered_deps` from gate results.
- `phase-gates`: "Gate tool" lets a named gate name its proposer tool, refuses a bare `spec_gate` for it, runs a registered validator and effects on approval, and refuses gates of a parked change.
- `unit-evidence`: "Unit start tool" treats units listed by a `parked` record as pending and accepts a green `Verify` for them after resume.
- `change-close`: "Closed without merge" lets `--abandon` close a change with no pull request after a `new-dependency` choice D `drop`, and states that an abandoned dependency keeps its dependents waiting.
- `flow-pack`: "Default flow pack" gains `size-limits` in `plan` and `decisions.split`.

## Impact

- **New code:** `src/initiatives/` (graph and cycles, readiness, propose and gate completion, split, size and overlap checks, card lines), `src/deps/` (new-dependency options, park, resume, parked record), tools `initiative-propose.ts`, `new-dependency.ts`, `change-split.ts`, `change-sync.ts`, `change-park.ts`, `change-resume.ts` under `src/tools/`.
- **Changed code:** `src/tools/change-start.ts`, `src/tools/subagent-outcome.ts` and `src/subagents/result.ts`, `src/engine/gates.ts` and `src/interaction/complete-gate.ts` (proposer and gate effects), `src/evidence/unit-state.ts` and `src/tools/unit-start.ts` (parked units), `src/ship/close.ts` (abandon after D), `src/engine/next-step.ts`, `src/engine/counters.ts`, `src/engine/checks.ts`, `src/hooks/card-input.ts` and `phase-card.ts`, `src/engine/git.ts` (commit-all, merge), `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json` (`size-limits` in plan, `decisions.split`), `src/decide/registry.ts` (`split`).
- **Docs:** `docs/architecture.md` (initiatives, discovered dependencies).
