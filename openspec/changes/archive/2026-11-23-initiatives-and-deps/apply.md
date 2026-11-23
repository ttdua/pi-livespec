# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `initiatives-and-deps`
**Iteration**: `1`
**Applied at**: `2026-11-23 04:30`
**Executor**: `subagent-driven-development` (implementer `superspec.implementer`, task reviewer `superspec.task-reviewer`; final whole-branch review and fix-wave re-review by `superspec.task-reviewer`; no model override, thinking from plan Difficulty)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.initiatives-and-deps`
- **Worktree branch**: `initiatives-and-deps`
- **Feature branch**: `LS-09c`
- **Base branch**: `main`

---

## Commits

- **Range**: `66495a2..755d35a` (this receipt's commit follows `755d35a`)
- **Count**: `34`

---

## Tasks

- **Completed**: `45 of 45` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

Validation at `755d35a`: `bun run typecheck` exit 0; `bun run test` 3341/3341 passing (225 files). Full suite run clean four times after Task 9, so the temp-dir flake Task 9 saw once (red-on-base/worktree) did not come back.

---

## Contract deviations

All internal; no `public` contract changed without a recorded reason.

- `gateValidator` / `gateEffects` / `namedGate` lookups and `ParkedCore` type (src/engine/gates.ts, src/engine/parked.ts): accessors the completion engine needs (Task 2).
- `sendNamedGate` (src/tools/spec-gate.ts): offers `waive` first when a waivable check fails, then the proposer's options; the validator wraps forge text in `untrusted()` itself (Task 2).
- `size-limits` "Over the unit limit" scenario: reworded to "refused (or, when completed, superseded)". No adapter can approve while a waivable check fails (Task 3 ruling).
- `changeDependencies(forge, { issue: { number }, change })` (src/initiatives/readiness.ts): it takes the issue number as well, which it needs to find the change's initiative entry (Task 4).
- `PlanCtx.states?`, helpers `dependsValue`, `referencedNumbers`, `readReferenced` (src/initiatives/): amendment rules need dependency states (Task 5).
- `CHANGE_BODY_TEMPLATE`, `changeBody`, `dependsValue` moved to src/core/change-body.ts and re-exported from src/tools/change-new.ts, so src/initiatives/ does not import src/tools/ (Task 5 ruling).
- `initiative_propose` refuses, and its validator supersedes, a new initiative whose name is taken by an open `livespec:initiative` issue. The spec gained the scenario "Initiative name taken" (Task 5 ruling).
- `readReferenced` refuses ("too many dependencies to check") at 200 reads instead of truncating (Task 5).
- `change_split`: exports `pendingBlock`, `capabilitiesValue`, `Capabilities`; adds the refusals "every unit would move" and "`<title>-split` name taken"; the kept body drops each moved block together with its blank line (Task 6).
- `SyncContext.signal`; a missing or guard-blocked `Verify` gets verdict `invalid` with exit `null`; `regression.<head>` and `stale.sync.<head>` are skipped when already present; `Base`, then `livespecBase`, are written last (Task 7 review).
- `insertChangeBefore` + `DraftEntry.before`; `applyInitiative` dedupes `Depends`; `findOrCreateChange` accepts no initiative; `LatestDependencyChoice` carries `reason` and `unit`; the `new-dependency` validator also supersedes on a name taken or the cap reached meanwhile (Task 8).
- Generic named-gate scenarios in the phase-gates delta use `custom-gate`, because `new-dependency` now has a proposer and `spec_gate` refuses it (Task 8 ruling).
- `parked` record `waits_for` lists every dependency unmerged at park time instead of only `#new`. Park refuses when that list is empty. Design D13 and the plan contract were updated (Task 9).
- `change_resume` removes the `livespec:parked` label before posting the resume record; `change_park` refuses a dirty change worktree with no started unit; a park rerun reuses an existing wip commit; park uses its own guarded lane cleanup instead of `lane-ops.closeLane`, never deleting a lane branch whose commits no pushed wip branch holds (Task 9 review).
- Tracking issues created by the `initiative` and `new-dependency` gates carry a line `<!-- livespec:request <id> -->` after `Capabilities:`. Completion adopts an existing tracking issue only when it carries the request id. Existing bodies stay valid, and `parseInitiative` reads them unchanged. The `<title>-split` initiative from `change_split` has no marker (final review fix wave).
- The option D `drop` follow-up puts the reason on its own `Reason:` line after `change_close --abandon <reason>`. Every drafted value in follow-up text is wrapped `untrusted()` (final review fix wave).

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 Dependency graph, readiness reads and markers | sequential | `66495a2..046f8ea` | Approved (5 minor) | n/a |
| 2 Named gate seam | sequential | `6af54ab..1d1500e` | Approved (4 minor) | n/a |
| 3 Size limits and the split rule | sequential | `0bdfe90..f06a231` | Approved (3 minor; spec wording ruling) | n/a |
| 4 Readiness at start, on the card and in the next step | sequential | `49e9c85..40be981` | Approved (5 minor) | n/a |
| 5 Initiative propose, gate completion and amendments | sequential | `48a5124..54bba7e` | Approved after fix round 1 | n/a |
| 6 Change split | sequential | `2a921b1..7414eaf` | Approved after fix round 1 | n/a |
| 7 Sync with the integration branch | sequential | `a4f10b9..7e4d77f` | Approved after fix round 1 | n/a |
| 8 New dependency gate, options and counter | sequential | `85b3b5b..baf4804` | Approved (6 minor) | n/a |
| 9 Park and resume | sequential | `875a154..6710675` | Approved after fix round 1 | n/a |
| 10 Done-when flows and docs | sequential | `6632db0..d6f81d5` | Approved after fix round 1 | n/a |
| Final whole-branch review | sequential | `66495a2..6d74308`, fix wave `6d74308..755d35a` | With fixes → fix wave Approved | n/a |

---

## Next step

Run `/opsx-verify`. Parked items for the verifier and the code review gate:
- Card `Next:` line after a `missing-prerequisite` result names `new_dependency` only in the dispatch outcome text, not through `nextStep` (ruling).
- Any approved amendment completes the B/C follow-up (spec literal).
- `initiativeTaken` checks only the first same-titled open initiative.
- The C follow-up puts `<untrusted>U<n></untrusted>` inside the `unit_amend` command.
- Tracking issues created before this change carry no request marker, so a crashed in-flight completion is not reused after the upgrade.
- Remote wip branches stay on the remote after resume (known gap, documented in docs/architecture.md).
