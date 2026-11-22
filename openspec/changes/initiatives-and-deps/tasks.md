## 1. Dependency graph, readiness reads and markers

Blocked by: none

- [x] 1.1 `src/initiatives/graph.ts`: pure `dependencyGraph` (union of a change's `Depends` line and its initiative entry's `Depends`), `findCycle` (DFS, self-edge counts) and `formatCycle` (`#a → #b → #a`); tests in `tests/initiatives/graph.test.ts` (change-initiatives "Depends cycle rejection": "Self dependency")
- [x] 1.2 `src/initiatives/readiness.ts`: `readDependencies(forge, numbers)` (issue closed and the `PR` line's pull request merged → `merged`; closed otherwise → `abandoned`; else `open`; read errors propagate) and `isReady`; tests with the memory forge (change-initiatives "Change dependencies and readiness": all three scenarios)
- [x] 1.3 Initiative body writers in `src/core/initiative.ts`: `appendChange`, `insertChangeAfter`, `setChangeDepends` and `removeChange`, keeping every other byte; round-trip tests next to the existing ones in `tests/core/`
- [x] 1.4 Register marker kinds `parked` and `regression`, and add lane outcome `parked` to `LANE_OUTCOME_NAMES` in `src/subagents/validate.ts`

## 2. Named gate seam

Blocked by: 1

- [x] 2.1 `NamedGate.proposer`, plus `registerGateValidator` and `registerGateEffect` in `src/engine/gates.ts`; `spec_gate` refuses a gate with a proposer and names the tool (`src/tools/spec-gate.ts`)
- [x] 2.2 Run the named-gate validator in `validateGate` (`src/interaction/complete-validate.ts`), and the effects in `applyGate` (`src/interaction/complete-gate.ts`) only for a valid approved answer, before the `gate` comment
- [x] 2.3 Let a proposer tool send a named-gate request with its own options and snapshot drafts: export a builder from `src/tools/spec-gate.ts` that reuses `gateRequest`/`sendRequest`
- [x] 2.4 Derive the parked core (`parkedRecord`) in `deriveCommentFacts` (`src/engine/parked.ts`), and add the parked refusal in `gateRefusal`, except for `new-dependency` and `initiative`; proposer gates skip `dirtyTree` and the `head_sha`/`gate_digest` checks in `validateGate`
- [x] 2.5 Tests in `tests/engine/gates.test.ts`, `tests/interaction/complete.test.ts` and `tests/tools/spec-gate.test.ts` (phase-gates "Gate tool": "Gate with a proposer", "Gate effect runs once before the result", "Validator supersedes", "No effect on changes requested", "Parked change refuses the plan gate", "Proposer gate survives work in progress", "Forge answer on a parked change")

## 3. Size limits and the split rule

Blocked by: 2

- [ ] 3.1 `src/initiatives/size-limits.ts`: waivable check `size-limits` over `limits.max_units` and `limits.max_capabilities` (a missing limit never fails), registered in `registerBuiltinChecks`. `CheckContext` gains `limits`, filled by `runChecks` from the pack
- [ ] 3.2 `src/initiatives/split-rule.ts`: rule `split` (`registerRule`, schema `mode` only, never asks) and its facts from the change; registered in `src/decide/builtin.ts`
- [ ] 3.3 Default pack: `size-limits` in `plan` checks and `decisions.split: { mode: rule }` in `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json` (flow-pack "Default flow pack": all scenarios)
- [ ] 3.4 Tests: `tests/initiatives/size-limits.test.ts` and `tests/initiatives/split-rule.test.ts`, plus a plan-gate tool test (change-initiatives "Size limits check": "Over the unit limit", "Waived"; "Split rule": both scenarios)

## 4. Readiness at start, on the card and in the next step

Blocked by: 1, 2, 3

- [ ] 4.1 `change_start` refuses when a dependency is not merged, naming each with its state, or when a dependency cannot be read (`src/tools/change-start.ts`); tests in `tests/tools/change-start.test.ts` (change-tools "Change start refusals": "Dependency not merged", "Dependency merged", "Abandoned dependency")
- [ ] 4.2 Refresh facts: `ChangeState.deps` (dependency states, initiative entries with ready flags, capability overlap) via `registerRefreshFacts` in `src/hooks/card-input.ts`, filled by `src/initiatives/facts.ts`, memoized on the session by issue versions
- [ ] 4.3 `nextStep` rule 3 sentence for unmet dependencies (`src/engine/next-step.ts`); test in `tests/engine/next-step.test.ts` (flow-engine "Next step precedence": "Not started with an unmet dependency")
- [ ] 4.4 Card: an initiative progress section, the dependency states and the ready entries, the overlap warning (registered card section), and the open-changes list states `ready` / `waits for` (`src/hooks/phase-card.ts`); also in `spec_status` details. Tests in `tests/hooks/phase-card.test.ts` and `card-input.test.ts` (change-initiatives "Initiative progress on the card": both scenarios; "Capability overlap warning")
- [ ] 4.5 Shape card names `initiative_propose` when `split` returns `propose` (change-initiatives "Split rule": "Too many capabilities suggests an initiative")

## 5. Initiative propose, gate completion and amendments

Blocked by: 1, 2

- [ ] 5.1 `src/initiatives/propose.ts`: validate entries (kebab names, exactly one current entry, `Depends` targets, name clashes for new entries only, cycles) and build the gate snapshot and payload; new vs amendment mode (allowed and refused edits per "Initiative amendment")
- [ ] 5.2 `src/tools/initiative-propose.ts`, registered in `src/tools/change-tools.ts` and the tool-name lists in `tests/extension.test.ts` and `tests/tools/register.test.ts`; `registerGate("initiative", { proposer })`
- [ ] 5.3 Validator and effect for `initiative` in `src/initiatives/complete.ts`: find-or-create the tracking issue, then the change issues in topological order, then the `## Changes` list, then the current change's body. Each step is idempotent; amendments apply edits to both `Depends` line and entry (design D6)
- [ ] 5.4 Tests in `tests/tools/initiative-propose.test.ts`: "Proposal sent", "Cycle refused", "Bare spec_gate refused", "Approval creates everything at once", "Retry after a crash", "Changes requested", "New change added midway", "Abandoned dependency removed from a started change", "Amendment cycle refused", "Planned change cannot be re-proposed", "Initiative closes after an abandoned entry is removed"

## 6. Change split

Blocked by: 1, 3, 5

- [ ] 6.1 `src/initiatives/split.ts`: pure planning of the moved units, `Depends: #N`, the capability split and the refusals (unknown, done, started, in lane, parked, remaining depends on moved, pending plan gate)
- [ ] 6.2 `src/tools/change-split.ts` (registered as in 5.2): create the issue, versioned write on `#N`, `stale` listing `plan` and later phases, label back to `plan` when past it, and the initiative insert or `<name>-split` initiative (design D8)
- [ ] 6.3 Tests in `tests/tools/change-split.test.ts` (change-initiatives "Change split tool": all scenarios)

## 7. Sync with the integration branch

Blocked by: 1, 4, 6

- [ ] 7.1 `src/initiatives/sync.ts`: fetch and merge with abort on conflict, the new `Base` and `livespecBase`, the `regression` record from every done unit's `Verify` (`runVerify`), and the stale units from red results plus the requirements changed in `specs/` between bases. When past `build`, a stale listing later phases and a label move to `build` (design D12)
- [ ] 7.2 `src/tools/change-sync.ts` (registered as in 5.2) and the `integrationAhead` refresh fact; the `sync` rule in `nextStep`, after `receiptedUnit` (`src/engine/next-step.ts`)
- [ ] 7.3 Tests in `tests/tools/change-sync.test.ts` and `tests/engine/next-step.test.ts` against a real origin (change-initiatives "Sync with the integration branch": all scenarios; flow-engine "Sync before the next unit")

## 8. New dependency gate, options and counter

Blocked by: 2, 5, 7

- [ ] 8.1 `src/deps/new-dependency.ts`: drafts validation, options (A default first, `split` when done and not-done units exist), payload, `registerGate("new-dependency", { proposer })`, validator (cap and A cycles)
- [ ] 8.2 `src/tools/new-dependency.ts` (registered as in 5.2), refused in a child session and while the cap blocks
- [ ] 8.3 Effects per choice: A creates the prerequisite and adds it to the initiative (or creates `<change>-deps`), then writes `Depends` on both line and entry, reusing `src/initiatives/complete.ts`; C creates the follow-up; D `shape` posts a `stale` listing `shape` and later phases and moves the label (design D9)
- [ ] 8.4 Derived `discovered_deps` (ignore its counter comment) with the stuck-lift rule in `src/engine/counters.ts`/`snapshot.ts`; next-step rule 7 follow-ups (`src/engine/next-step.ts`); tests in `tests/engine/counters.test.ts` and `next-step.test.ts` (flow-engine "Loop counters": "Counter shown with cap", "Derived discovered dependencies"; discovered-dependencies "Discovered dependencies counter", "New dependency follow-up")
- [ ] 8.5 `missing-prerequisite` names `new_dependency`, or `spec_stuck` at the cap, with no attempt counted (`src/subagents/result.ts`, `src/tools/subagent-outcome.ts`); tests in `tests/tools/subagent-dispatch.test.ts` and `subagent-record.test.ts` (subagent-dispatch "Result handling": both new scenarios)
- [ ] 8.6 `change_close --abandon` accepts a change with no `PR` line after choice D `drop` (`src/ship/close.ts`); tests in `tests/tools/change-close.test.ts` (change-close "Closed without merge": "Drop after a discovered dependency", "Abandon refused without a pull request or drop")
- [ ] 8.7 Tool tests in `tests/tools/new-dependency.test.ts` (discovered-dependencies "New dependency tool" and "New dependency options": all scenarios)

## 9. Park and resume

Blocked by: 7, 8

- [ ] 9.1 Git ports for a given worktree: `addAll` and `commit(message, { allowEmpty })` (wip merges reuse the existing `merge`, which is `--no-ff`), plus lane worktree removal reuse, in `src/engine/git.ts`; tests on a real repo
- [ ] 9.2 `src/deps/parked.ts`: the `parked` record writer and reader, the `parked` fact on `ChangeState` (waiting list from current dependencies), and the unit-evidence change in `src/evidence/unit-state.ts` (park supersedes older starts and restarts the attempt window; `resumed` verdict)
- [ ] 9.3 `src/tools/change-park.ts` (registered as in 5.2; the fourth `guardedPush` caller): per in-progress unit wip branch, commit, push `<Branch>--wip-<unit>`; close lanes as `parked` and delete their local branches; label; `parked` record last; idempotent rerun (design D13)
- [ ] 9.4 `src/tools/change-resume.ts`: refusals, `change_sync` steps, wip merges in unit order skipping merged heads, resume record and label removal (design D14)
- [ ] 9.5 Parked refusals in `change_start`, `unit_start` (green accepted as `resumed`), `unit_finish` and `change_split`; next-step rule 6 and the parked card section (unit-evidence "Unit start tool": "Parked change refuses", "Resumed unit starts green"; context-injection "Phase card content": "Parked and initiative lines"; flow-engine "Parked change waits", "Park before finishing a started unit")
- [ ] 9.6 Allow `change-park.ts` in `tests/guard/push-callers.test.ts` and add the wip refspec test (command-guards "Guarded push": "No tool calls the push path", "Refspec of a wip branch")
- [ ] 9.7 Tests in `tests/tools/change-park.test.ts` and `change-resume.test.ts` with two lanes against a real origin (discovered-dependencies "Park tool", "Parked state" and "Resume tool": all scenarios)

## 10. Done-when flows and docs

Blocked by: 4, 5, 6, 9

- [ ] 10.1 `tests/e2e/initiative-flow.test.ts` for the #34 Done-when cases:
  - a plan over the limits cannot be approved without a split or a waiver;
  - change B cannot start before change A merges;
  - a parked change with two lanes in progress resumes with no lost work;
  - a `Depends` cycle is rejected.
- [ ] 10.2 `docs/architecture.md`: initiatives (propose, readiness, sync, size limits, split) and discovered dependencies (gate options, park, resume, known gap: wip branches stay on the remote); the tool list in the diagram
- [ ] 10.3 Full `bun run test` and `bun run typecheck` pass
