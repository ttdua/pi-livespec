## Context

The pieces this change builds on already exist:
- `parseInitiative`, `serializeInitiative` and `tickChange` (`src/core/initiative.ts`), and the change header lines `Initiative` and `Depends` (`src/core/change.ts`).
- Named gates with options (`registerGate` in `src/engine/gates.ts`), completed by `applyGate` (`src/interaction/complete-gate.ts`). Waivable checks (`registerCheck(..., { waivable: true })`).
- Counters (`src/engine/counters.ts`) and the pack values `limits` and `loops.discovered_deps`.
- Lane records (`src/subagents/state.ts`), unit evidence derived from comments (`src/evidence/unit-state.ts`), `guardedPush` (`src/guard/push.ts`), `runVerify`, and the `stale` marker (`src/interaction/stale.ts`).
- The `missing-prerequisite` mapping to `stuck` (`src/subagents/result.ts`).

`nextStep` is pure, so every forge or git fact it needs is read at refresh in `src/hooks/card-input.ts`, as ship facts already are.

## Goals / Non-Goals

**Goals:** the brainstorm's goals, as two modules: `src/initiatives/` (graph, readiness, propose, split, size limits, overlap, sync) and `src/deps/` (new-dependency, park, resume). They depend on `core`, `engine`, `forge` and `interaction`, never the reverse. The engine reaches them only through registered hooks: gate effects, card sections and refresh facts.

**Non-Goals:** the brainstorm's non-goals. No forge sub-issues or dependency links. Wip branches are not deleted from the remote after resume, because no delete path exists through `guardedPush`.

## Decisions

**D1. Dependency graph and cycles.** A change's dependencies are the union of its own `Depends` line and the `Depends` of its entry in its initiative's `## Changes` list. The union fails safe when the two disagree. `dependencyGraph(entries)` is pure: it returns adjacency by issue number. `findCycle(graph)` returns the first cycle as a list of numbers in DFS order (a self-edge is a cycle). Every writer of `Depends` that can close a loop builds the graph it would produce and refuses on a cycle, naming it as `#a → #b → #a`. The writers are the `initiative` gate and its amendments (at propose time and again at validation), and option A of `new-dependency`, whose prerequisite draft may depend on existing changes. `change_split` cannot close a loop (the new change only gets `Depends: #N`), so it needs no check. *Alternative:* trust only the initiative list. Rejected: a change outside an initiative (after `change_split`) has only its own line.

**D2. "Merged" is read from the forge.** Dependency `#D` is merged when its issue is closed, its `PR:` line names a pull request, and `getPullRequest` reports `merged: true`. Any other state is `waiting`: open, closed without a `PR` line, or closed with an unmerged pull request (abandoned). A `waiting` dependency that is closed is shown as `abandoned`. *Alternative:* the own `close-summary` record. Rejected: only own markers count, so a change another account closed would never become ready. `readDependencies(forge, numbers)` returns `{ number, title, state: "merged" | "open" | "abandoned" }[]`. A read failure throws, so the refresh degrades and `change_start` refuses.

**D3a. Parked core is derived from comments.** `parkedRecord(marked)` (the latest `parked` record, its units and `at`) lives in `src/engine/parked.ts` and is filled by `deriveCommentFacts`, so `stateNow` in answer validation sees it too and a forge answer for a gate of a parked change is superseded. Only the dependency states it waits for come from the refresh hook. The engine owns the shared fact types (`DepFact`, `ParkedUnit`) and the derived `discoveredDeps` (`src/engine/deps-facts.ts`), so `src/initiatives/` and `src/deps/` import the engine and never the reverse.

**D3. Readiness facts at refresh.** `ChangeState` gains `deps?: { items: DepFact[]; initiative?: InitiativeFacts; overlap: …; integrationAhead?: boolean; siblingMerged?: boolean; split? }` and `parked?` (the parked core plus the dependency states, see D3a). It is filled in `card-input.ts` through one registered refresh hook (`registerRefreshFacts`), which keeps the engine free of initiative imports. `InitiativeFacts` holds `{ number, entries: { number, name, checked, ready }[] }`. The refresh hook also evaluates the `split` rule for `shape` and puts its outcome in `deps.split`, because `nextStep` cannot call `decide`. The memo is keyed by HEAD plus the issue versions read; it saves the pull request reads, not the issue reads. `nextStep` gains three rules (D11). The open-changes list card shows each change's state the same way (`ready`, `waits for #34`, `parked`), capped like the list itself.

**D4. Named gates with a proposer and a validator.** `NamedGate` gains `proposer?: string`, the tool that builds the request with its drafts, and `registerGateValidator(name, fn)` adds a check that `validateGate` runs after the shared refusals (name clashes and cycles for `initiative`, the cap for `new-dependency`). `spec_gate <name>` refuses a gate with a proposer, naming the tool, because a bare request has no drafts. That refusal lives in `runSpecGate` only, never in `gateRefusal`, because `validateGate` reuses `gateRefusal` when it completes an answer. A proposer gate is not head-bound: `gateRefusal(…, { proposer: true })` skips `dirtyTree`, and `validateGate` skips the `head_sha` and `gate_digest` checks for it. Park needs exactly the uncommitted work that a dirty-tree refusal would forbid, and lanes keep ticking units while the human decides. Both gates in this change set it: `initiative` → `initiative_propose`, `new-dependency` → `new_dependency`. A gate request may carry its own options (snapshot `options`), so `new-dependency` can offer `split` only when the change has done units. *Alternative:* parameters on `spec_gate`. Rejected: `spec_gate` is deliberately parameter-free apart from its target.

**D5. Gate effects.** `registerGateEffect(name, fn)` adds an effect that `applyGate` runs only for a valid `approved` or `approved_with_notes` answer, after the overrides and before the `gate` comment is written. An effect must be idempotent against the forge state it reads, because a crash leaves the request applying and the next poll reruns it. The effect sees the request snapshot (drafts) and the answer (`choice`). The `gate` comment stays the result, so the derived state (counters, park) keys off it.

**D6. `initiative` completion order.** The snapshot holds `{ name, goal, capabilities, entries: [{ name, proposal, depends: [names] }], current: <n> }`, with the current change as an entry named by its title. The steps run in this order, and each one finds before it creates:
1. Tracking issue: an open issue labelled `livespec:initiative` with title `<name>`, else it creates one with `Goal`, `Capabilities` and an empty `## Changes`.
2. Change issues, in topological order: an open `livespec` issue with that title and `Initiative: #T`, else it creates one. The new issue gets labels `livespec` and `livespec:phase/shape`, and a body with `Initiative: #T`, `Depends: #…` (resolved from names), the template lines and the short Proposal.
3. The tracking `## Changes` list, in the same order, through a versioned write.
4. The current change's body: `Initiative`, `Depends` and its Proposal from the draft, through a versioned write.

A name that, at validation, matches an open issue without `Initiative: #T` supersedes the answer. When `current` already has an `Initiative` line, the request is an **amendment** of that initiative instead. It may add changes, edit the Proposal of a change with no `## Units`, edit the `Depends` of a change with no `Branch`, and remove an abandoned dependency from any open change or the entry of an abandoned change. Step 1 then reuses `#T`. A removed entry leaves the list, so the normal `change_close` of the last remaining change closes the initiative. An amendment is light: the payload shows only the affected entries. Gates of a parked change refuse except `new-dependency` and `initiative`, so an abandoned prerequisite can be removed while parked.

**D7. `size-limits` and `capability-overlap`.** `size-limits` is a waivable check in `plan`. It reports one error per exceeded limit (`N units exceed max_units 8`, `N capabilities exceed max_capabilities 3`), and a missing limit never fails. Capability overlap needs the forge, so it is a refresh fact, not a check. It lists every other open change with a `Branch` whose `Capabilities` shares a name with this change's, and the card and `spec_status` show it as a warning. *Alternative:* a check with forge access in `CheckContext`. Rejected: checks run inside answer validation, and a forge search per validation is wasteful.

**D8. `change_split`.** The parameters are `{ issue, units: ["U5", "U6"], into }`, and the tool runs on the branch of `#N`. It refuses when:
- a listed unit is done, started or in an open lane;
- a remaining unit `Depends` on a moved unit;
- the name is not kebab-case or is already taken;
- the change is parked, or a listed unit is on its `parked` record;
- the plan gate of `#N` is pending.

It creates the new change in `shape` with `Initiative` (when `#N` has one), `Depends: #N` (only when a moved unit depends on a unit that stays), `Capabilities` taken from the capabilities the moved units' `Covers` name (removed from `#N` when no remaining unit covers them, so a capability-limit failure can be fixed by a split), and the moved unit blocks under `## Units`. When `#N` has no initiative and the new change depends on it, a `<name>-split` initiative is created so readiness and the card cover both. Status lines are reset to pending and `Depends` on moved ids are kept, with no renumbering. It then removes the units from `#N` with a versioned write, posts a `stale` comment listing `plan` and every later phase on `#N` (not counted), and moves `#N`'s label back to `plan` when it is past it, which reopens its plan gate. When `#N` is in an initiative, it inserts the entry after `#N`'s entry. The new change's plan gate opens naturally once it reaches `plan`. *Alternative:* go through `unit_amend --drop`. Rejected: a drop under a light gate would ask the human once per unit, while the split already reopens the plan gate.

**D9. `new_dependency` and its options.** The parameters are `{ unit?, evidence, a: { name, proposal, depends? }, b: { units, summary }, c: { summary, follow_up: { name, proposal } }, d: { action: "shape" | "drop", reason } }`. The tool refuses when the `discovered_deps` cap blocks (D10), or a `gate:new-dependency` request is pending. The options are `A` (labelled recommended, offered first), `B`, `C`, `D`, and `split` when at least one unit is done and one is not. The effects (D5) by choice are:
- `A`: create the prerequisite change. It goes into the change's initiative when there is one; otherwise it creates an initiative named `<change>-deps` that holds the new change and then this one (D6 steps 1 to 3). It then writes `Depends: #new` on this change. Cycles are checked as in D1.
- `B`: no effect. The next step names `unit_amend --add`.
- `C`: create the follow-up change issue in `shape` with no `Depends`. The next step names `unit_amend U<n>` for the stub.
- `D` with `shape`: a `stale` comment listing `shape` and every later phase (`after_plan: false`, so not a counted iteration), plus moving the phase label to `shape` (a direct label move, like `advancePhase`). Listing `shape` matters: otherwise the old approved `shape` self gate would advance the change again at once. `D` with `drop`: no effect. The next step names `change_close --abandon <reason>`, which now accepts it (change-close delta).
- `split`: no effect. The next step names `change_split` with the unfinished units.

An approved answer with no choice is treated as `A`, the default. After an approved choice, a next-step rule (D11) names its follow-up until a newer record shows it done: `parked` for A, an approved `amendment` for B and C, the closed issue for D `drop`, a `stale` listing `plan` for `split`. For A inside an initiative, `#new` is written both on the change's `Depends` line and in its `## Changes` entry; this is the one write allowed on a started change's `Depends` besides removing an abandoned dependency (D6).

**D10. `discovered_deps` is derived.** A `missing-prerequisite` result keeps `kind: "stuck"` in `interpret` with a new flag `prerequisite: true`, so the `DispatchOutcome` union keeps its kinds; `finish()` carries the flag, and `outcomeText`/`resultText` render it as `new_dependency`, or `spec_stuck` when their callers pass `depsCapped`. The inline path (`subagent_record` of a `BLOCKED` `missing-prerequisite` result) uses the same text. The run record writes no `progress` record for it. It counts the valid approved `new-dependency` gate results with choice `A`, `B`, `C` or `split`, so a counter comment for it is ignored, as for the other derived loops. When the count is at least `loops.discovered_deps` and no stuck answer with a choice is dated after the latest counted result, the cap blocks. `new_dependency` then refuses, naming `spec_stuck`, and a `missing-prerequisite` result points to `spec_stuck`. This reuses the iteration-cap lift rule (`liftsCap`).

**D11. Next-step rules.** Rule 3 (not started, `notStarted` in code) gains the unmet-dependency sentence; the parked and follow-up rules go right after the pending-request rule (`openRequest`, before `capBlocking`), so a pending `new-dependency` request on a parked change still shows; the sync rule goes before the per-phase steps:
- **parked**: "waiting for #X to merge" while a waited-for dependency is not merged. Once all are merged: "#X merged: a human runs `change_resume #N`".
- **not started with unmet `Depends`**: this replaces the plain `change_start` sentence of rule 3: "waits for #A, #B; a human runs `change_start #N` once they merge".
- **new-dependency follow-up**: see D9.
- **integration ahead**, in `build`, `review` and `ship`, after the unit evidence rules (`receiptedUnit`) and before `nextUnit`: the change has an initiative, an entry other than this change is checked, and the local `origin/<integration>` (read without fetching) is not an ancestor of HEAD. The step is "run `change_sync`".

**D12. `change_sync`.** It runs on the change branch with a clean tree and no started unit, and is shared with resume:
1. Fetch `origin/<integration>`. When it is not an ancestor of HEAD, run `git merge --no-edit origin/<integration>`. A conflict runs `git merge --abort` and refuses, saying to merge by hand and rerun. A rerun sees the integration tip as an ancestor and goes on.
2. Write `Base: <integration tip>` and the `livespecBase` git config, so `capabilities-match-diff` (`Base..HEAD -- specs/`) does not see a sibling's spec edits.
3. Re-run every done unit's `Verify` at HEAD and post one own `regression` record `{ base, head, units: [{ unit, exit, verdict, tail }] }`.
4. Collect the done units whose `Verify` is red or invalid, plus the done units whose `Covers` names a requirement added, removed or changed in `git diff <old Base>..<new Base> -- specs/`. Those units are unticked in one versioned body write, and a `stale` comment (`after_plan: false`) lists them with phases `[]`. That makes them stale, so `unit_amend` (or re-approval of the amendment) is needed before build continues. When the change is past `build`, the same `stale` comment lists every phase after `build` and the label moves to `build`, so review runs again on the rebuilt units.

A conflicted merge sends the change back to review through the existing reviewed-SHA rule. *Alternative:* leave Base unchanged. Rejected: `capabilities-match-diff` would fail on every sibling merge.

**D13. Park (`change_park`).** It is a parent tool, refused in a child session, and runs only when the latest valid `new-dependency` result chose `A` and no newer `parked` record exists. For each in-progress unit:
- **Lane unit:** an open lane, whose worktree holds commits and uncommitted work.
- **Change-worktree unit:** a started unit with no lane.

For each such unit it runs `git switch -c livespec/<change>--wip-<unit>` in that worktree, `git add -A`, then `git commit --allow-empty -m "wip(<unit>): parked for #<new>"`, then `guardedPush(origin, HEAD:refs/heads/livespec/<change>--wip-<unit>)`. It then switches the change worktree back to the change branch (a lane worktree is removed after its push). It closes each lane record with outcome `parked`, adds the label `livespec:parked`, and posts one `parked` record `{ waits_for: [#new], units: [{ unit, branch, head, lane }], at }`. A unit with no commit since its pre SHA and no uncommitted work gets no wip branch. Each step is idempotent:
- an existing local wip branch at the expected commit is reused;
- the push is re-run, which is safe;
- the record is written last, so a crash before it leaves the change unparked with pushed branches, and a rerun completes the park.

`deriveUnitEvidence` treats a `unit-start` older than a `parked` record that lists the unit as not started, and starts the unit's attempt window at that record, so those units return to pending with a fresh budget. Park writes no `progress` record, so attempts do not increase. *Alternative:* park as a gate effect. Rejected: a forge answer can be completed on another machine, without the worktrees.

**D14. Resume (`change_resume #N`).** It is a parent tool run on the change branch. It refuses unless the change is parked and every `waits_for` dependency is merged (D2). It runs `change_sync` steps 1 to 4 and then merges each wip branch of the `parked` record into the change branch (`git merge --no-ff --no-edit`, in unit order). Lanes had disjoint `Files`, so these merges do not conflict with each other. A conflict with the integration merge aborts, refuses and names the branch, and a rerun skips wip heads already merged (`isAncestor`). It finally posts a `parked` record `{ resumed: true, at }` and removes the label. After resume, `unit_start` for a unit listed in a `parked` record newer than its latest `unit-start`, followed by a resume record, also accepts a green `Verify`, with verdict `resumed`, because its red evidence is the earlier `unit-start` the park record superseded. Units continue sequentially or through new lanes from HEAD, which already holds their partial work.

**D15. Guard and push scope.** `change_park` builds the refspec from the issue's `Branch` line and the unit id (`<Branch>--wip-<unit>`), never from a parameter. The guard scan test allows `change-park.ts` as a fourth importer of the push module.

**D16. Tools and placement.** New tools: `initiative_propose`, `new_dependency`, `change_split`, `change_sync`, `change_park` and `change_resume`, in `src/tools/`. Each is registered through `registerLivespecTool`, and all except `initiative_propose` refuse in a child session. Rule `split` (`registerRule("split", …)`, config `decisions.split: { mode: rule }`) decides at shape whether to suggest an initiative. Its facts are the change's declared capability count and the number of drafted units when known. It returns `propose` when either exceeds the pack limits, and the shape card then names `initiative_propose`. It never asks.

## Risks / Trade-offs

- [Gate effect creating several issues crashes midway] → each step finds by title and `Initiative: #T` before it creates. The request stays applying, and the next poll finishes it.
- [Readiness reads one issue and one pull request per dependency on each refresh] → reads are bounded by the number of dependencies, and on the list card by `OPEN_CHANGES_CAP`. The facts are memoized on the session by issue versions.
- [The integration-ahead step fires on integration moves unrelated to a sibling] → merging is harmless and keeps the branch current; the step appears only once a sibling merged.
- [A wip commit contains secrets or generated files] → `git add -A` respects `.gitignore`, the same tree the agent would commit. The commit is pushed only to a `livespec/` branch.
- [Wip branches pile up on the remote] → known gap; documented in architecture.
- [`resumed` verdict weakens red-before evidence] → it applies only to units the park record lists, and only after a `unit-start` that recorded a valid red.

## Migration Plan

Additive. Changes without `Depends` or an initiative behave as before. `change_start` refuses only when a `Depends` is unmerged. The default pack gains `size-limits` in `plan` and `decisions.split`; project packs that list `plan` checks explicitly keep their own list. Rollback: revert the change, because no stored format changes; the new markers are ignored by older code.

## Open Questions

None.
