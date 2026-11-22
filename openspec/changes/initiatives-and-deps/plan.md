# Initiatives and Discovered Dependencies Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` (`change-initiatives`, `discovered-dependencies`, `change-tools`, `subagent-dispatch`, `command-guards`, `change-close`, `flow-pack`, `context-injection`, `flow-engine`, `phase-gates`, `unit-evidence`) and `design.md` (D1–D16).

**Goal:** Large work is split into initiatives with a `Depends` order that a human approves. Changes start only after their dependencies merge. Plans over the limits need a split or a waiver. A prerequisite found mid-build parks the change without losing any lane's work and resumes after the prerequisite merges.

**Architecture:**
- **Engine-owned facts:** `src/engine/parked.ts` (`parkedRecord`) and `src/engine/deps-facts.ts` (`DepFact`, `ParkedUnit`, `discoveredDeps`, `latestDependencyChoice`) are pure comment and fact derivations, so answer validation sees them. Check and rule registration go through the existing `registerBuiltinChecks` and `registerBuiltinRules` lists, as for `durable-docs` and `lane`.
- **`src/initiatives/`**: graph and cycles, readiness, propose and gate completion, split, size limits, sync, and refresh facts.
- **`src/deps/`**: new-dependency drafts and effects, park and resume records.
- **Engine and interaction:** they gain three generic seams and never import `src/initiatives/` or `src/deps/` except through the builtin registration lists:
  - a named-gate proposer, validator and effects (D4, D5);
  - refresh facts on `ChangeState` (D3);
  - next-step rules that read those facts (D11).
- **Tools:** they stay thin. Refusals come first, in spec order, then effects. Every forge write is versioned and each step is idempotent.

**Tech Stack:** TypeScript (ESM, `.ts` imports), Bun, vitest, the `yaml` package, and the git CLI through `GitExec`. Tests use the memory forge and real temporary repos with an origin (`tests/tools/helpers.ts` `toolHarness`, `tests/tools/unit-helpers.ts`, `tests/tools/lane-helpers.ts` `openLane`, `tests/helpers/repo.ts`).

## Global Constraints

- Labels `livespec:initiative` and `livespec:parked` (constants in `src/forge/labels.ts`). New marker kinds: `parked` and `regression`.
- Initiative entry line, exactly as `CHANGE_ENTRY`: `- [ ] #<n> <name> — Depends: <#a, #b | —>`. The em dash is U+2014.
- Cycle text: issue numbers or entry names joined by ` → `, with the first node repeated at the end (`#34 → #35 → #34`).
- Wip branch `<Branch line>--wip-<unit>`, for example `livespec/per-ip-cap--wip-U2`. Wip commit message `wip(<unit>): parked for #<n>`.
- Generated initiative names: `<change>-deps` (option A without an initiative) and `<change>-split` (split without an initiative).
- Pack defaults: `limits: { max_units: 8, max_capabilities: 3 }` and `loops.discovered_deps: 2`, both unchanged. New: `decisions.split: { mode: rule }` and `size-limits` in `plan` checks.
- `guardedPush` importers in `src/tools/`: only `change-ship.ts`, `change-push.ts`, `fix-ship.ts` and `change-park.ts`.
- No tool takes an outcome, choice or answer parameter, and `tests/tools/no-answer-params.test.ts` gains `initiative_propose` and `new_dependency`.
- Every `stale` comment this change writes has `after_plan: false`.
- One writer per file: tasks that edit the same file are ordered by `Blocked by`.
- No new dependency. Parent-only tools refuse in child sessions through `childRefusal`.
- Forge text in output is wrapped with `untrusted()`.
- Commits in English, conventional style (`feat(initiatives): …`, `feat(deps): …`).

## Review Focus

- A dependency issue that cannot be read (deleted, or a forge error) must make `change_start` refuse and name it, never treat it as merged. Test `unreadable dependency refuses` in Task 4.
- `Depends` naming a non-`livespec` issue or a pull request number must make `initiative_propose` refuse. Test `foreign issue in Depends refused` in Task 5.
- An initiative completion where the forge returns a body conflict on step 3 must leave the request applying, and the next poll must finish it without duplicate issues. Test `conflict on the changes list retries` in Task 5.
- Park while a lane worktree was deleted by hand (the lane record is open but the path is missing): the unit is listed with no branch and not counted as lost. Park must not throw. Test `missing lane worktree is listed without a branch` in Task 9.
- Resume when the integration merge conflicts with a wip branch: the merge is aborted, the change stays parked, and a rerun after a hand merge skips merged heads. Test `wip conflict aborts and rerun skips merged` in Task 9.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `DepGraph` / `dependencyGraph` | new | `type DepGraph = Map<number, number[]>`; `dependencyGraph(changes: { number: number; depends: number[] }[], initiative?: Initiative): DepGraph` (union per number) in `src/initiatives/graph.ts` | no |
| `findCycle` / `formatCycle` | new | `findCycle<K>(graph: Map<K, K[]>): K[] \| undefined` (DFS in insertion order; returns `[a, b, …, a]`); `formatCycle(cycle: (number \| string)[]): string` (numbers as `#n`, joined by ` → `) | no |
| `DepState` / `DepFact` / `ParkedUnit` | new | `type DepState = "merged" \| "open" \| "abandoned"`; `type DepFact = { number: number; title: string; state: DepState }`; in `src/engine/deps-facts.ts` | no |
| `readDependencies` / `isReady` | new | `readDependencies(forge: Forge, numbers: number[]): Promise<DepFact[]>` (rejects on a forge error); `isReady(facts: DepFact[]): boolean` in `src/initiatives/readiness.ts` | no |
| Initiative body writers | new | `appendChange(body: string, e: { number: number; name: string; depends: number[] }): string`; `insertChangeAfter(body: string, after: number, e): string`; `setChangeDepends(body: string, n: number, depends: number[]): string`; `removeChange(body: string, n: number): string`; `initiativeBody(goal: string, capabilities: string[]): string` in `src/core/initiative.ts` | no |
| `NamedGate` | modified | `{ checks: string[]; options?: GateOption[]; proposer?: string }` | no |
| `gateRefusal` | modified | `gateRefusal(state, pack, target, ignoreRequest?, opts?: { proposer?: boolean })`; with `proposer` it skips `dirtyTree`. The proposer refusal (`spec_gate` on a gate with a proposer) is NOT a `REFUSALS` rule: it runs only in `runSpecGate` | no |
| `validateGate` | modified | for a gate with a proposer: no `head_sha` or `gate_digest` check, `gateRefusal(…, { proposer: true })`, then the registered validator | no |
| `gateRequest` | modified | `gateRequest(state, pack, target, plan, input: { body; payload; now; drafts?: unknown })`; `drafts` goes into `GateSnapshot.drafts` | no |
| `parkedRecord` | new | `parkedRecord(marked: MarkedComment[]): { index: number; waitsFor: number[]; units: ParkedUnit[]; at: string } \| undefined` (undefined when the latest `parked` record is a resume or absent) in `src/engine/parked.ts`; filled into `ChangeState.parkedCore` by `deriveCommentFacts` | no |
| `Caps.discoveredDeps` | modified | `Caps` gains optional `discoveredDeps?: number` (existing `Caps` literals in tests stay valid); the three callers (`card-input.ts`, `complete-validate.ts`, `snapshot.ts`) pass `pack.loops.discovered_deps`; `DERIVED_COUNTERS` gains `discovered_deps` | no |
| `ResultDecision` / `DispatchOutcome` stuck | modified | `{ kind: "stuck"; reason; result; prerequisite?: true }` from `interpret` (`src/subagents/result.ts`), carried through `finish()` in `src/subagents/dispatch.ts`; no new kind, no `progress` record | no |
| `outcomeText` / `resultText` | modified | `outcomeText(t, outcome, o?: { depsCapped?: boolean })` and `resultText(…, o?)` in `src/tools/subagent-outcome.ts`; callers `subagent-dispatch.ts`, `subagent-answer.ts`, `subagent-record.ts` pass `depsCapped` from `state.counters` and the pack cap | no |
| `new-dependency` answer without choice | new | an approved answer with no `choice` counts as `A` | yes |
| `registerGateValidator` | new | `registerGateValidator(name: string, fn: (ctx: CompletionCtx, req: RequestRecord, ans: Answered) => Promise<string \| undefined>): void` in `src/engine/gates.ts`; a returned reason supersedes the answer | no |
| `registerGateEffect` | new | `registerGateEffect(name: string, fn: (run: Run, record: AnswerData) => Promise<void>): void`; run by `applyGate` for a valid `approved`/`approved_with_notes` answer, before the `gate` comment | no |
| `GateSnapshot` | modified | `{ target; failingWaivable; findings?; drafts?: unknown }`; `drafts` holds the proposer's payload (initiative entries, new-dependency drafts) | no (stored in the `request` comment) |
| `sendNamedGate` | new | `sendNamedGate(w: WriteContext, state: ChangeState, i: { target: string; options: RequestOption[]; drafts: unknown; summary: string; ctx: ApproverCtx; tool: string }): Promise<ToolResult<undefined>>` exported from `src/tools/spec-gate.ts` | no |
| `CheckContext.limits` | modified | `limits?: Record<string, number>`, filled by `runChecks` from `pack.limits` | no |
| Check `size-limits` | new | waivable; errors `code: "size-limits"`, messages `"<n> units exceed max_units <m>"`, `"<n> capabilities exceed max_capabilities <m>"` | yes (pack check name) |
| Rule `split` | new | `registerRule("split", splitSchema, splitRuleFn)`; facts `{ capabilities: number; units: number; limits: { max_units?: number; max_capabilities?: number } }`; outcome `"propose" \| "single"`; config `decisions.split: { mode: rule }` | yes (pack key) |
| `ChangeState.deps` | new | `deps?: { items: DepFact[]; initiative?: { number: number; checked: number; total: number; ready: { number: number; name: string }[] }; overlap: { number: number; title: string; capabilities: string[] }[]; integrationAhead?: boolean; siblingMerged?: boolean }` | no |
| `ChangeState.parkedCore` | new | `parkedCore?: NonNullable<ReturnType<typeof parkedRecord>>`, filled by `deriveCommentFacts` | no |
| `ChangeState.parked` | new | `parked?: { waitsFor: DepFact[]; units: ParkedUnit[]; at: string }`, present while parked; built by the refresh hook from `parkedCore` plus the dependency states. Refusals that must hold in validation read `parkedCore` | no |
| `ChangeState.deps.split` | new | `split?: "propose" \| "single"`, the `split` rule outcome computed by the refresh hook in `shape` | no |
| `registerRefreshFacts` | new | `registerRefreshFacts(fn: (session: Session, state: ChangeState) => Promise<Partial<Pick<ChangeState, "deps" \| "parked">>>): void` in `src/hooks/card-input.ts`; also called by `requireChange` consumers through the same refresh | no |
| `OpenChange` | modified | `{ number; title; phase?; readiness?: "ready" \| { waits: number[] } \| "parked" }` | no |
| `parked` marker | new | id `parked.<k>` (`k` = base36 ms); data `{ waits_for: number[]; units: ParkedUnit[]; at: string } \| { resumed: true; at: string }`; `ParkedUnit = { unit: string; branch?: string; head?: string; lane: boolean }` | yes (issue comment format) |
| `regression` marker | new | id `regression.<head>`; data `{ base_from: string; base_to: string; head: string; units: { unit: string; exit: number \| null; verdict: "green" \| "red" \| "invalid"; tail: string }[] }` | yes (issue comment format) |
| `LANE_OUTCOME_NAMES` | modified | adds `"parked"` | no |
| `StartRecord.pre.verdict` | modified | adds `"resumed"` | yes (`unit-start` data) |
| `Git` worktree ports | new | `addAll(): Promise<void>` (`git add -A`); `commit(message: string, o?: { allowEmpty?: boolean }): Promise<string>` (returns the new HEAD); `mergeOrigin(ref: string): Promise<"ok" \| "conflict">` (`git merge --no-edit -- <ref>`, fast-forward allowed, used by sync); wip merges use the existing `merge` (`--no-ff`) | no |
| Tool `initiative_propose` | new | params `{ name: string; goal: string; capabilities: string[]; entries: { name: string; proposal: string; depends: string[] }[]; remove?: string[] }` (`depends` items are entry names or `#<n>`; `remove` lists `#<n>` entries or `#<change>:#<dep>` dependency removals, amendment only) | yes |
| Tool `new_dependency` | new | params `{ unit?: string; evidence: string; a: { name: string; proposal: string; depends?: string[] }; b: { units: string[]; summary: string }; c: { summary: string; follow_up: { name: string; proposal: string } }; d: { action: "shape" \| "drop"; reason: string } }` | yes |
| Tool `change_split` | new | params `{ issue: number; units: string[]; into: string }`; details `{ number?: number }` | yes |
| Tool `change_sync` | new | params `{}`; details `{ base?: string; stale?: string[] }` | yes |
| Tool `change_park` | new | params `{}`; details `{ units?: ParkedUnit[] }` | yes |
| Tool `change_resume` | new | params `{ issue: number }`; details `{ merged?: string[] }` | yes |
| Tool `change_close` | modified | unchanged params; `abandon` accepted without a `PR` line after choice D `drop` | yes |
| Gate `initiative` | new | `registerGate("initiative", { checks: [], proposer: "initiative_propose" })`; drafts `{ name; goal; capabilities; entries; current: number; amend?: number; remove?: … }` | yes |
| Gate `new-dependency` | new | `registerGate("new-dependency", { checks: [], options: A,B,C,D,split, proposer: "new_dependency" })`; option ids `A`, `B`, `C`, `D`, `split`; label of `A` ends with `(default)` | yes |
| Loop `discovered_deps` | modified | now derived (D10); counter comment ignored | no |
| `CloseSummary.pr` / `CloseEvents.closed.pr` | modified | `pr?: number` (absent only on the D `drop` abandon path with no `PR` line) in `src/ship/close.ts`; the `close-summary` marker data omits `pr` then | yes (issue comment format, event payload) |

---

## Task 1: Dependency graph, readiness reads and markers — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/initiatives/graph.ts`, `src/initiatives/readiness.ts` (imports `DepFact` from `src/engine/deps-facts.ts`, created here as a types-only file with `DepState`, `DepFact` and `ParkedUnit`)
- Modify: `src/core/initiative.ts`, `src/subagents/validate.ts`, `src/extension.ts` (imports the markers module), `src/deps/markers.ts` (create, registers `parked` and `regression`)
- Test: `tests/initiatives/graph.test.ts`, `tests/initiatives/readiness.test.ts`, `tests/core/initiative.test.ts`

**Interfaces:**
- Produces: `DepGraph`, `dependencyGraph`, `findCycle`, `formatCycle`, `DepFact`, `readDependencies`, `isReady`, the initiative body writers, and the marker kinds.

- [ ] **Step 1:** Graph tests:
  - `findCycle(new Map([[34,[35]],[35,[34]]]))` deep-equals `[34,35,34]`;
  - a self-edge `[[7,[7]]]` → `[7,7]` ("Self dependency");
  - an acyclic graph → `undefined`;
  - `formatCycle([34,35,34]) === "#34 → #35 → #34"` and `formatCycle(["a","b","a"]) === "a → b → a"`;
  - `dependencyGraph` unions a change's line `[34]` with its entry's `[36]` into `[34,36]`.
- [ ] **Step 2:** Run `bunx vitest run tests/initiatives/graph.test.ts`. Expect FAIL. Implement it. Expect PASS.
- [ ] **Step 3:** Readiness tests with the memory forge:
  - `Waiting on an open change`: #34 is open → `state: "open"` and `isReady` false;
  - `Ready after merge`: #34 is closed with `PR: #41` and pull request 41 is merged → `"merged"`;
  - `Abandoned dependency`: closed with no `PR` line, or with an unmerged pull request → `"abandoned"`;
  - `unreadable dependency rejects`: `getIssue` throws `ForgeError` → the call rejects.
- [ ] **Step 4:** Implement `readDependencies`, using `parsePrNumber` from `src/ship/pull-request.ts`. Run. Expect PASS.
- [ ] **Step 5:** Body writer tests on `tests/fixtures/initiative-body.md`:
  - `appendChange` adds `- [ ] #36 audit-log — Depends: #35` after the last entry;
  - `insertChangeAfter(…, 34, …)` places it after #34;
  - `setChangeDepends(…, 35, [34, 40])` writes `Depends: #34, #40`;
  - `removeChange(…, 34)` drops the line.

  In every case the other bytes are unchanged and `parseInitiative` round-trips. `initiativeBody("g", ["a"])` → `Goal: g\nCapabilities: [a]\n\n## Changes\n`.
- [ ] **Step 6:** Implement. Run. Expect PASS. Add `registerKind("parked")` and `registerKind("regression")` in `src/deps/markers.ts`, imported by `src/extension.ts` registration, and add `"parked"` to `LANE_OUTCOME_NAMES`. Run `bun run typecheck`.
- [ ] **Step 7:** Commit `feat(initiatives): dependency graph, readiness and initiative writers`.

---

## Task 2: Named gate seam — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5
**Difficulty:** Hard
**Blocked by:** Task 1 (`ParkedUnit` type and the `parked` marker kind its tests write)

**Files:**
- Create: `src/engine/parked.ts`
- Modify: `src/engine/gates.ts`, `src/engine/state-types.ts` (`parkedCore`, `parked?`, `deps?` fields), `src/engine/snapshot.ts` (`deriveCommentFacts`), `src/interaction/complete-gate.ts`, `src/interaction/complete-validate.ts`, `src/interaction/approver.ts` (`GateSnapshot.drafts`), `src/tools/spec-gate.ts`
- Test: `tests/engine/gates.test.ts`, `tests/interaction/complete.test.ts`, `tests/tools/spec-gate.test.ts`

**Interfaces:**
- Consumes: the existing `gateRequest` (`src/tools/spec-gate.ts`), `sendRequest` (`src/tools/request-flow.ts`), `applyGate` and `validateGate`.
- Produces: `NamedGate.proposer`, `registerGateValidator`, `registerGateEffect`, `GateSnapshot.drafts`, `sendNamedGate`, and the parked refusal.

- [ ] **Step 1:** Tests:
  - `Gate with a proposer`: register `initiative` with proposer `initiative_propose`. `spec_gate initiative` returns an error naming `initiative_propose`, and no `request` comment is written.
  - `Validator supersedes`: a validator returns `"name taken"`. Completing an approved answer posts an `answer` with `verdict: superseded` and that reason, and the effect spy is not called.
  - `Gate effect runs once before the result`: the effect writes a comment. The first completion throws after the effect and before the `gate` comment (inject by making `postComment` fail once). After `finishApplying`, the effect's comment exists once and is before the `gate` comment; the effect is idempotent by checking its own comment.
  - `No effect on changes requested`: the spy is not called.
  - `Parked change refuses the plan gate`: `gateRefusal` with `state.parkedCore` set and target `plan` names the parked state, while targets `new-dependency` and `initiative` are not refused for it.
- [ ] **Step 2:** Run the three test files. Expect FAIL.
- [ ] **Step 3:** Implement the registry maps in `gates.ts`, plus `resetGatesForTests` clearing them; gate registrations therefore live in functions (`registerInitiativeGate()`, `registerNewDependencyGate()`) called from the tool registration, never at module top level. Put the proposer refusal in `runSpecGate` only. Add `parkedRule` (reads `state.parkedCore`) after `capReached`, and the `opts.proposer` skip of `dirtyTree`. In `validateGate`, for a gate with a proposer skip `head_sha`/`gate_digest`, call `gateRefusal(…, { proposer: true })`, then the validator. Run the effects in `applyGate` between the overrides and `gateComment`.
- [ ] **Step 3b:** Implement `parkedRecord` in `src/engine/parked.ts` and fill `parkedCore` in `deriveCommentFacts`. Tests: `Forge answer on a parked change` (superseded), `Proposer gate survives work in progress` (dirty tree at request, ticked unit and moved HEAD before the answer → valid), and `approved initiative answer is valid` (guards against the proposer refusal leaking into validation).
- [ ] **Step 4:** Extend `gateRequest` with `drafts` (stored in `GateSnapshot.drafts`), and implement `sendNamedGate` on top of it and `sendRequest`, passing its own options and calling `gateRefusal(…, { proposer: true })`.
- [ ] **Step 5:** Run. Expect PASS. Run `bunx vitest run tests/tools tests/interaction`. Existing named-gate scenarios (`Registered gate`, `Named gate option recorded`, `Named gate option does not waive`) still pass.
- [ ] **Step 6:** Commit `feat(gates): named gate proposer, validator and effects`.

---

## Task 3: Size limits and the split rule — implements 3

**Covers:** 3.1, 3.2, 3.3, 3.4
**Difficulty:** Easy
**Blocked by:** Task 2 (both edit `tests/tools/spec-gate.test.ts`)

**Files:**
- Create: `src/initiatives/size-limits.ts`, `src/initiatives/split-rule.ts`
- Modify: `src/engine/registry.ts` (`CheckContext.limits`), `src/engine/checks.ts`, `src/decide/registry.ts`, `src/packs/agent-skills.yaml`, `tests/fixtures/agent-skills.pack.json`
- Test: `tests/initiatives/size-limits.test.ts`, `tests/initiatives/split-rule.test.ts`, `tests/engine/pack-load.test.ts`, `tests/tools/spec-gate.test.ts`

**Interfaces:**
- Produces: the check `size-limits`, the rule `split` with `splitFacts(change: Change, limits: Pack["limits"])`, and `CheckContext.limits`.

- [ ] **Step 1:** Check tests:
  - 9 units with `max_units: 8` → one error, message `9 units exceed max_units 8`;
  - 4 capabilities with `max_capabilities: 3` → `4 capabilities exceed max_capabilities 3`;
  - no `limits` → `[]`;
  - `isWaivable("size-limits")` is true.
- [ ] **Step 2:** Rule tests:
  - `Too many capabilities suggests an initiative`: 4 capabilities → outcome `propose`;
  - `Within limits`: 2 capabilities and no units → `single`;
  - a schema key other than `mode` is reported.
- [ ] **Step 3:** Run both. Expect FAIL. Implement both, register the check in `registerBuiltinChecks` and the rule in `registerBuiltinRules`, and pass `limits: pack.limits` in `runChecks`.
- [ ] **Step 4:** Add `size-limits` to `plan.checks`, after `verify-red-on-base`, and `split: { mode: rule }` to the YAML and the fixture. Update the `Spot check` test assertions as in flow-pack "Default flow pack". Run `bunx vitest run tests/engine/pack-load.test.ts`. Expect PASS.
- [ ] **Step 5:** Gate tool tests in `spec-gate.test.ts` with a 9-unit plan:
  - `Over the unit limit`: an in-session approve with no waive → the answer is superseded and the phase stays `plan`;
  - `Waived`: a `waive` choice → the gate comment lists `size-limits` under `waivers` and the next step advances to `build`.

  Run. Expect PASS.
- [ ] **Step 6:** Commit `feat(initiatives): size-limits check and split rule`.

---

## Task 4: Readiness at start, on the card and in the next step — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4, 4.5
**Difficulty:** Hard
**Blocked by:** Task 1, Task 2 (both edit `state-types.ts`), Task 3 (the shape-card step reads the `split` rule)

**Files:**
- Create: `src/initiatives/facts.ts`, `src/initiatives/card.ts`
- Modify: `src/tools/change-start.ts`, `src/hooks/card-input.ts` (`registerRefreshFacts`, `registerListFacts`), `src/hooks/phase-card.ts`, `src/engine/state-types.ts`, `src/engine/next-step.ts`, `src/engine/resolve-change.ts` (`OpenChange.readiness`), `src/tools/spec-status.ts`, `src/hooks/session.ts` (memo slot)
- Test: `tests/tools/change-start.test.ts`, `tests/initiatives/facts.test.ts`, `tests/engine/next-step.test.ts`, `tests/hooks/phase-card.test.ts`, `tests/hooks/card-input.test.ts`

**Interfaces:**
- Consumes: Task 1 `readDependencies`, `dependencyGraph`; Task 3 the `split` rule.
- Produces: `ChangeState.deps`, `registerRefreshFacts`, `OpenChange.readiness`, and `changeDependencies(forge, change): Promise<DepFact[]>` (the union of the line and the entry, for Tasks 7–9).

- [ ] **Step 1:** `change_start` tests:
  - `Dependency not merged`: `#35` with `Depends: #34`, #34 open → error text names `#34` and `open`, and no `livespec/` branch exists;
  - `Dependency merged` → the branch is created;
  - `Abandoned dependency` → names `abandoned`;
  - `unreadable dependency refuses`: `getIssue(34)` throws → refuses naming #34;
  - `entry depends only`: the initiative entry says `Depends: #34`, the line says `—` → refused;
  - `stale cached dependency refuses`: the forge is read-only and #34 comes from the cache (`issue.stale`) → refused, naming read-only mode.
- [ ] **Step 2:** Run. Expect FAIL. In `validateStart`, after `issueRefusal`, call `changeDependencies`, refuse on `!isReady`, and map a thrown `ForgeError` to a refusal. Run. Expect PASS.
- [ ] **Step 3:** Facts and next-step tests:
  - `Not started with an unmet dependency`: a pure `nextStep` with `deps.items` `[{34, open}]` and no `Branch` in `define` gives a sentence that names `#34` and `change_start`;
  - `facts.test.ts`: capability overlap lists `#36` sharing `rate-limit` (both have `Branch`, and one without `Branch` is ignored).
- [ ] **Step 4:** Implement `registerRefreshFacts` in `card-input.ts` (`changeState` merges the hook results) and `src/initiatives/facts.ts`. Memoize only the pull request reads on `session`, keyed by the sorted `version`s of the issues read; issue reads, `integrationAhead` and `siblingMerged` are computed on every refresh. Update rule 3 (`notStarted`) in `next-step.ts`. Run. Expect PASS.
- [ ] **Step 5:** Card tests:
  - `Progress shown`: `initiative #30: 1 of 2 done` and `#34 merged`;
  - `Ready changes proposed`: the list card on `main` shows `#34 … ready` and `#35 … waits for #34`;
  - `Two open changes modify the same capability`: the warning line names `#36` and `rate-limit`, wrapped as untrusted;
  - `Too many capabilities suggests an initiative`: the shape card names `initiative_propose`.

  Implement `src/initiatives/card.ts` with `registerCardSection("initiative", …)`; the shape card reads `deps.split`, computed by the refresh hook with `decide("split", splitFacts(…))`. The list readiness is a second hook, `registerListFacts(fn: (session, open: OpenChange[]) => Promise<OpenChange[]>)` in `src/hooks/card-input.ts`, called after `resolveChange` returns `none`, for at most `OPEN_CHANGES_CAP` changes; the `parked` label (not comments) marks a listed change as parked. `spec_status` details gain `deps`. Run. Expect PASS.
- [ ] **Step 6:** Run `bun run test`, then commit `feat(initiatives): readiness at change_start, card and next step`.

---

## Task 5: Initiative propose, gate completion and amendments — implements 5

**Covers:** 5.1, 5.2, 5.3, 5.4
**Difficulty:** Very Hard
**Blocked by:** Task 1, Task 2

**Files:**
- Create: `src/initiatives/propose.ts`, `src/initiatives/complete.ts`, `src/tools/initiative-propose.ts`
- Modify: `src/tools/change-tools.ts`, `src/tools/change-new.ts` (export `CHANGE_BODY_TEMPLATE` builder `changeBody(o: { initiative?: number; depends: number[]; proposal: string })`), `tests/extension.test.ts`, `tests/tools/register.test.ts`, `tests/tools/no-answer-params.test.ts`
- Test: `tests/tools/initiative-propose.test.ts`, `tests/initiatives/propose.test.ts`

**Interfaces:**
- Consumes: Task 1 graph, writers and readiness; Task 2 `sendNamedGate`, `registerGateValidator` and `registerGateEffect`.
- Produces:
  - `planInitiative(input, state, ctx: { open: Issue[]; referenced: Map<number, Issue | "missing"> }): { drafts: InitiativeDrafts } | { refused: string }` (the tool reads every `#n` in `Depends` with `getIssue` first; anything without the `livespec` label, including a pull request or a missing number, is refused; a closed merged change is a valid dependency);
  - `applyInitiative(run: Run, drafts: InitiativeDrafts): Promise<{ tracking: number; created: Record<string, number> }>`, reused by Task 8 for option A;
  - `findOrCreateChange(forge, title, initiative, body)`.

- [ ] **Step 1:** Pure planning tests in `propose.test.ts`:
  - `Cycle refused`: `a → b → a`;
  - `Self dependency`;
  - an unknown `Depends` name;
  - a non-kebab name;
  - `foreign issue in Depends refused` (`#99` has no `livespec` label, or is missing);
  - `closed merged dependency accepted` (`Depends: #12`, a closed change with a merged pull request);
  - a new entry's name clashing with an open issue;
  - no current entry, or two;
  - amendment refusals: removing a non-abandoned entry, `Planned change cannot be re-proposed` (the message names `change_split` or `unit_amend`), editing `Depends` of a change with `Branch`;
  - `Amendment cycle refused`.

  Run. Expect FAIL. Implement. Expect PASS.
- [ ] **Step 2:** Tool tests:
  - `Proposal sent`: one pending `gate:initiative` request, its payload lists both entries, and no issue is created;
  - `Bare spec_gate refused`;
  - the tool is refused outside `shape` when the change has no `Initiative`;
  - `Cycle refused` and `Self dependency` at the tool level: an error and no `request` comment.

  Implement `src/tools/initiative-propose.ts` and register the gate in the module's top-level `registerInitiativeGate()`, called from `change-tools.ts`. Add the tool to the name lists and to `DECISION_TOOLS` in `no-answer-params.test.ts`.
- [ ] **Step 3:** Completion tests:
  - `Approval creates everything at once`: an in-session approve creates the tracking issue with the label, `#a` in `shape` with `Initiative: #T`, the `## Changes` lines in order, and #20 with `Initiative: #T`, `Depends: #a` and the new Proposal;
  - `Changes requested`: no issues;
  - `Retry after a crash`: inject a `createIssue` failure on the second call, then `finishApplying` → exactly one tracking issue and one `add-request-context` issue;
  - `conflict on the changes list retries`: the first `updateIssueBody` on the tracking issue returns a conflict, then the retry succeeds without duplicates.
- [ ] **Step 4:** Implement `applyInitiative` (D6 steps 1–4, find-before-create by label, title and `Initiative` line) and the validator (name clash without `Initiative: #T`, cycle); `registerInitiativeGate()` registers the gate, the validator and the effect together. Run. Expect PASS.
- [ ] **Step 5:** Amendment tests:
  - `New change added midway`: `audit-log` is appended with `Depends: #20`;
  - `Abandoned dependency removed from a started change`: both #35's line and entry become `—`, and #34's entry is removed;
  - `Initiative closes after an abandoned entry is removed`: after the amendment, #35 merges and `change_close` closes #30 and emits `livespec:initiative-closed`. This uses the existing `closeInitiative`, unchanged.

  Implement the amendment branch of `applyInitiative`. Run. Expect PASS.
- [ ] **Step 6:** Commit `feat(initiatives): initiative_propose and the initiative gate`.

---

## Task 6: Change split — implements 6

**Covers:** 6.1, 6.2, 6.3
**Difficulty:** Hard
**Blocked by:** Task 1, Task 3, Task 5 (reuses `changeBody` and `findOrCreateChange` to create the new issue and the `<name>-split` initiative)

**Files:**
- Create: `src/initiatives/split.ts`, `src/tools/change-split.ts`
- Modify: `src/tools/change-tools.ts`, `tests/extension.test.ts`, `tests/tools/register.test.ts`
- Test: `tests/initiatives/split.test.ts`, `tests/tools/change-split.test.ts`

**Interfaces:**
- Consumes: Task 1 writers; Task 5 `changeBody` and `findOrCreateChange`; `staleComment`; `phasesAfter`; `renderUnit`, `insertUnitBlock` and `removeUnitBlock` (`src/core/unit-blocks.ts`); `parkedCore` (Task 2) for the parked refusal.
- Produces: `planSplit(change: Change, state: ChangeState, units: string[]): SplitPlan | { refused: string }`, where `SplitPlan = { moved: Unit[]; keptBody: string; newCapabilities: { new: string[]; modified: string[] }; keptCapabilities: …; dependsOnN: boolean }`.

- [ ] **Step 1:** Pure tests:
  - `Split refused when a remaining unit depends on a moved one`: the message names U7 and U5;
  - `Started unit cannot move`;
  - done, unknown or in-lane units are refused;
  - `Split refused while parked`;
  - `dependsOnN` is true when U5 depends on U2, which stays;
  - `Split brings the capability count within limits`: the capabilities are partitioned by the moved units' `Covers`.

  Run. Expect FAIL. Implement. Expect PASS.
- [ ] **Step 2:** Tool tests:
  - `Split with a dependency on a unit that stays`: the new issue holds U5 and U6 as pending blocks with `Depends: #35`, #35's body has no U5 or U6, a `stale` comment lists `plan` and later phases, and the next step on #35 asks for the plan gate;
  - `Split during build returns to plan`: the label becomes `plan` and U1 stays ticked;
  - an initiative insert after `#35`'s entry;
  - without an initiative and with `dependsOnN`, a `per-ip-cap-split` initiative is created.

  Implement the tool. Run. Expect PASS.
- [ ] **Step 3:** Commit `feat(initiatives): change_split`.

---

## Task 7: Sync with the integration branch — implements 7

**Covers:** 7.1, 7.2, 7.3
**Difficulty:** Hard
**Blocked by:** Task 1, Task 4, Task 6 (both edit `change-tools.ts` and the tool-name tests)

**Files:**
- Create: `src/initiatives/sync.ts`, `src/tools/change-sync.ts`
- Modify: `src/engine/git.ts` (`mergeOrigin`), `src/initiatives/facts.ts` (`integrationAhead`, `siblingMerged`), `src/engine/next-step.ts` (rule 16), `src/tools/change-tools.ts`, the tool-name tests
- Test: `tests/tools/change-sync.test.ts`, `tests/engine/next-step.test.ts`, `tests/engine/git.test.ts`

**Interfaces:**
- Consumes: `runVerify`/`verifyEnv` (`src/evidence/runner.ts`), `livespecBaseKey`, `setHeaderLine`, `untickUnit` (`src/core/tick.ts`), `parseSpec`, `staleComment`, `phasesAfter`.
- Produces: `syncChange(ctx: { session; forge; state }): Promise<{ base: string; stale: string[] } | { refused: string }>`, reused by `change_resume`.

- [ ] **Step 1:** Next-step test `Sync before the next unit`: in `build` with a ready unit, `deps.siblingMerged: true` and `integrationAhead: true` → the sentence names `change_sync`. Also, with `integrationAhead: false` → the next unit is named.
- [ ] **Step 2:** Tool tests on a real origin, with sibling #34 merged into `origin/main` after #35's `Base`:
  - `Sibling merged`: the card names `change_sync`;
  - `Regression receipts`: one `regression` comment with U1 and U2 green, and the issue `Base` and `livespecBase` equal to the `origin/main` tip;
  - `Failing unit after the merge`: U2 is unticked, a `stale` comment names U2, and the next step names `unit_amend U2`;
  - `Regression during review`: the label moves to `build` and the stale lists `review`, `ship` and `close`;
  - `Conflict`: HEAD and `Base` are unchanged, and `git status` shows no merge in progress;
  - a requirement-change case: a requirement covered by U1 changed in `specs/` between the bases → U1 is stale even though it is green.
- [ ] **Step 3:** Implement `mergeOrigin`, then `syncChange` (D12 steps 1–4) and the tool. Insert the `sync` rule in `RULES` after `receiptedUnit` and before `nextUnit`; existing next-step assertions stay unchanged. Fill `integrationAhead` from `isAncestor(origin/<integration>, HEAD)` without fetching, and `siblingMerged` from the initiative's checked entries other than this one. Run. Expect PASS.
- [ ] **Step 4:** Commit `feat(initiatives): change_sync and regression records`.

---

## Task 8: New dependency gate, options and counter — implements 8

**Covers:** 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
**Difficulty:** Very Hard
**Blocked by:** Task 2, Task 5, Task 7 (both edit `next-step.ts`, `change-tools.ts` and their tests)

**Files:**
- Create: `src/deps/new-dependency.ts`, `src/deps/effects.ts`, `src/tools/new-dependency.ts`
- Modify: `src/engine/deps-facts.ts` (`discoveredDeps`, `latestDependencyChoice`), `src/engine/counters.ts` (`DERIVED_COUNTERS` gains `discovered_deps`), `src/engine/snapshot.ts` (`Caps.discoveredDeps`, derive it), `src/hooks/card-input.ts` and `src/interaction/complete-validate.ts` (pass the cap), `src/engine/next-step.ts` (rule 7), `src/subagents/result.ts`, `src/subagents/dispatch.ts`, `src/tools/subagent-outcome.ts`, `src/tools/subagent-dispatch.ts`, `src/tools/subagent-answer.ts`, `src/tools/subagent-record.ts`, `src/ship/close.ts`, `src/tools/change-close.ts`, `src/tools/change-tools.ts`, the tool-name tests, `tests/tools/no-answer-params.test.ts`
- Test: `tests/tools/new-dependency.test.ts`, `tests/engine/deps-facts.test.ts`, `tests/engine/counters.test.ts`, `tests/engine/next-step.test.ts`, `tests/engine/snapshot.test.ts`, `tests/tools/subagent-dispatch.test.ts`, `tests/tools/subagent-record.test.ts`, `tests/tools/change-close.test.ts`

**Interfaces:**
- Consumes: Task 2 seams; Task 5 `applyInitiative`, `findOrCreateChange` and `changeBody`; Task 1 graph and writers; `liftsCap` (`src/engine/iterations.ts`).
- Produces (in `src/engine/deps-facts.ts`):
  - `discoveredDeps(marked: MarkedComment[], cap?: number): { value: number; blocking: boolean }`;
  - `latestDependencyChoice(marked): { choice: "A" | "B" | "C" | "D" | "split"; action?: "shape" | "drop"; index: number } | undefined`, used by Task 9 and `change_close`.

- [ ] **Step 1:** Counter tests:
  - `Counter shown`: one valid approved result with choice `A` → `1`;
  - `Option D does not count`;
  - `Derived discovered dependencies`: a `counter` comment `discovered_deps: 9` is ignored;
  - `Counter shown with cap`: the custom loop `custom_loop` still comes from the counter comment;
  - `Cap exceeded`: A and B → `blocking` true, and a later stuck answer with a choice → false;
  - `approved without a choice counts`: an approved result with no `choice` → `1`.

  Run. Expect FAIL. Implement it in `src/engine/deps-facts.ts` and wire it into `deriveCommentFacts` as `counters.discovered_deps` (like `review_rounds`). Move the existing fixtures that use a `discovered_deps` counter comment to `custom_loop`: `tests/engine/counters.test.ts` (`readCounters`, `setCounter`) and `tests/engine/snapshot.test.ts` (expected `counters`). Expect PASS. Commit `feat(deps): derived discovered_deps`.
- [ ] **Step 2:** Tool tests:
  - `Gate sent with default A`: the option ids are `["A","B","C","D"]` in order and A's label ends with `(default)`;
  - `Split offered at the finished boundary`: `split` is appended;
  - `Cap exceeded`: the tool refuses and names `spec_stuck`;
  - `Cycle through an existing change`: A's draft depends on #35 while #35 depends on #34 → refused, naming the cycle;
  - the tool is refused in a child session;
  - `spec_gate new-dependency` is refused and names `new_dependency`;
  - `approved without a choice counts as A`.

  Implement `new-dependency.ts` and the tool (`registerNewDependencyGate()`). Commit `feat(deps): new_dependency tool and gate`.
- [ ] **Step 3:** Effect tests:
  - `Option A without an initiative`: `per-ip-cap-deps` lists `token-store` then #40 with `Depends: #<t>`, and #40 has the `Initiative` and `Depends` lines;
  - `Option A inside an initiative`: `#<t>` is inserted before #40's entry, and the entry and line both name #34 and #<t>;
  - `Option B`: no issue;
  - C creates the follow-up issue;
  - `Option D back to shape`: a stale listing `shape` and later phases, label `shape`, no advance at the next refresh, and `change_iterations` unchanged.

  Implement `src/deps/effects.ts`; its effect and the validator are registered inside `registerNewDependencyGate()`. Run. Expect PASS. Commit `feat(deps): new-dependency effects`.
- [ ] **Step 4:** Next-step tests for rule 7 (insert `followUp` in `RULES` after `openRequest`, before `capBlocking`; existing assertions unchanged):
  - after A → `change_park`;
  - `Follow-up of B ends with the amendment`;
  - after `split` → `change_split` with the units not done;
  - after D `drop` → `change_close --abandon`;
  - `Park before finishing a started unit`: rule 7 beats the started-unit rule.

  Implement. Run. Expect PASS.
- [ ] **Step 5:** Dispatch tests:
  - `Missing prerequisite opens the dependency gate`: the outcome text names `new_dependency U3` and the child's evidence (wrapped), and `unit_attempts.U3` is unchanged;
  - `Missing prerequisite past the cap`: names `spec_stuck`.

  In `statusDecision`/`interpret` keep `kind: "stuck"` for `missing-prerequisite` and set `prerequisite: true`; carry it through `finish()` in `dispatch.ts`; render it in `outcomeText`/`resultText` with `depsCapped` from the callers. Add an inline-path test in `tests/tools/subagent-record.test.ts` (`subagent_record` of a `BLOCKED` `missing-prerequisite` result names `new_dependency`). Assert no `progress.U3` comment is written. Run. Expect PASS.
- [ ] **Step 6:** Close tests:
  - `Drop after a discovered dependency`: #40 with no `PR` line and choice D `drop` → closed with the reason and `abandoned: true`;
  - `Abandon refused without a pull request or drop`.

  Extend `closeRefusal` and `summaryData` (no `pr` → `pr: 0` is not allowed, so make `CloseSummary.pr` optional and `CloseEvents.closed.pr` optional). The existing close scenarios must still pass. Run. Expect PASS.
- [ ] **Step 7:** Run `bun run test`, then commit `feat(deps): new-dependency gate, options and discovered_deps`.

---

## Task 9: Park and resume — implements 9

**Covers:** 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
**Difficulty:** Very Hard
**Blocked by:** Task 7, Task 8

**Files:**
- Create: `src/deps/parked.ts`, `src/deps/card.ts`, `src/tools/change-park.ts`, `src/tools/change-resume.ts`
- Modify:
  - `src/engine/git.ts` (`addAll`, `commit`);
  - `src/evidence/unit-state.ts`, `src/evidence/records.ts` (`resumed` verdict), `src/evidence/refusals.ts`;
  - `src/tools/unit-start.ts`, `src/tools/unit-finish.ts`, `src/tools/change-start.ts`;
  - `src/engine/next-step.ts` (rule 6), `src/initiatives/facts.ts` (`parked` fact);
  - `src/tools/change-tools.ts`, the tool-name tests, `tests/guard/push-callers.test.ts`.
- Test: `tests/tools/change-park.test.ts`, `tests/tools/change-resume.test.ts`, `tests/evidence/unit-state.test.ts`, `tests/tools/unit-start.test.ts`, `tests/engine/next-step.test.ts`, `tests/hooks/phase-card.test.ts`, `tests/engine/git.test.ts`

**Interfaces:**
- Consumes: Task 7 `syncChange`; Task 8 `latestDependencyChoice`; Task 4 `changeDependencies`; `openLanes`, `laneComment`, `unitRoot`, `guardedPush`, `createGit(lanePath)`.
- Produces: `parkedState(core: ReturnType<typeof parkedRecord>, deps: DepFact[]): ChangeState["parked"]`, `parkedComment(data)` and `isResumedUnit(marked, unit)`.

- [ ] **Step 1:** Git and evidence tests:
  - `addAll` and `commit` on a temp repo with an untracked and a modified file → one commit with both, and an ignored file left out;
  - `unit-state`: a `unit-start` for U2 followed by a `parked` record listing U2 → U2 is not in `started`, and `attempts.U2` is 0 even with earlier `progress.U2` records;
  - `isResumedUnit` is true only after a resume record follows that park.

  Run. Expect FAIL. Implement. Expect PASS.
- [ ] **Step 2:** Park tests, using `openLane` twice and a real origin:
  - `Two lanes in progress`: U2's lane has a commit and U3's lane has uncommitted edits. After `change_park`, `originRefs` contains `livespec/per-ip-cap--wip-U2` and `--wip-U3`. The U3 wip commit contains the edit. Both lane records are closed with outcome `parked`, the worktrees and local lane branches are gone, the label `livespec:parked` is present, and the last comment is the `parked` record naming #41, U2 and U3.
  - `Unit with no work is not branched`.
  - `Rerun after a failed push`: inject a `guardedPush` failure for U3 → the rerun reuses U2's branch and exactly one `parked` record exists.
  - `missing lane worktree is listed without a branch`.
  - Refused before choice A.
  - Refused in a child session.
- [ ] **Step 3:** Implement `change_park` (D13) and `src/deps/parked.ts`; commit `feat(deps): change_park`. Add `change-park.ts` to the allowed set in `push-callers.test.ts` and add the test `Refspec of a wip branch`. Run. Expect PASS.
- [ ] **Step 4:** Parked-state tests:
  - `Card while waiting`: names #41 and both wip branches;
  - `Parked change waits`: the next step;
  - `Resume proposed`: #41 merged → `change_resume #40`;
  - `Abandoned prerequisite removed`: after the amendment removes #41, there is no wait and resume is proposed;
  - `Parked change refuses` for `unit_start`, `unit_finish`, `change_start` and `change_split`;
  - `Parked and initiative lines`: the card has both sections.

  Implement rule 6 (insert `parked` in `RULES` right before `followUp`), the `parked` refresh fact and the card section. Run. Expect PASS.
- [ ] **Step 5:** Resume tests:
  - `Prerequisite not merged`: refused, nothing changes;
  - `Resume with two lanes keeps all work`: after #41 merges into `origin/main`, `change_resume #40` → HEAD contains the `origin/main` tip, U2's wip commit and U3's edited file content, a `regression` comment exists, the label is removed, and a resume `parked` record exists;
  - `Finished unit regresses`: U1 is stale;
  - `wip conflict aborts and rerun skips merged`;
  - `Resumed unit starts green`: after resume, `unit_start U2` with a green `Verify` posts verdict `resumed`.

  Implement `change_resume` (D14) and the `resumed` branch in `unit_start`. Run. Expect PASS.
- [ ] **Step 6:** Run `bun run test`, then commit `feat(deps): change_park and change_resume`.

---

## Task 10: Done-when flows and docs — implements 10

**Covers:** 10.1, 10.2, 10.3
**Difficulty:** Normal
**Blocked by:** Task 4, Task 5, Task 6, Task 9

**Files:**
- Create: `tests/e2e/initiative-flow.test.ts`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: every tool above, through `toolHarness` and in-session approvals, as in `tests/e2e/gates-flow.test.ts`.

- [ ] **Step 1:** Write four e2e tests, one per #34 Done-when bullet:
  - `plan over the limits needs a split or a waiver`: 9 units → approve is superseded; `change_split` brings it to 8 → approve passes; separately, `waive` passes;
  - `change B cannot start before change A merges`: through `initiative_propose`, its approval, `change_start` B refused, A merged and closed, then `change_start` B succeeds;
  - `parked change with two lanes resumes with no lost work`: through a `missing-prerequisite` result, `new_dependency` A, `change_park`, the prerequisite merged, then `change_resume`; both lanes' work is in HEAD;
  - `Depends cycle is rejected`.

  Run `bunx vitest run tests/e2e/initiative-flow.test.ts`. Expect PASS.
- [ ] **Step 2:** Update `docs/architecture.md`:
  - add `new_dependency`, `change_sync` and `change_park` to the tool list in the diagram (`change_split`, `change_resume` and `initiative_propose` are already listed);
  - add a section "Initiatives" (propose and its gate, readiness, the card, `change_sync`, `size-limits`, `change_split`, amendments);
  - add a section "Discovered dependencies" (gate options A–D and split, park and its wip branches, resume, `discovered_deps`, known gap: wip branches stay on the remote).
- [ ] **Step 3:** Run `bun run typecheck && bun run test`. Expect 0 failures.
- [ ] **Step 4:** Commit `docs(initiatives): architecture for initiatives and discovered dependencies`.

---

## Scenario → test

### change-initiatives
- Too many capabilities suggests an initiative → `tests/initiatives/split-rule.test.ts` (rule) + `tests/hooks/phase-card.test.ts` (card)
- Within limits → `tests/initiatives/split-rule.test.ts`
- Proposal sent → `tests/tools/initiative-propose.test.ts`
- Cycle refused → `tests/initiatives/propose.test.ts` + `tests/tools/initiative-propose.test.ts`
- Bare spec_gate refused → `tests/tools/initiative-propose.test.ts`
- Approval creates everything at once → `tests/tools/initiative-propose.test.ts`
- Retry after a crash → `tests/tools/initiative-propose.test.ts`
- Initiative name taken → `tests/initiatives/propose.test.ts` + `tests/tools/initiative-propose.test.ts`
- Changes requested → `tests/tools/initiative-propose.test.ts`
- New change added midway → `tests/tools/initiative-propose.test.ts`
- Abandoned dependency removed from a started change → `tests/tools/initiative-propose.test.ts`
- Initiative closes after an abandoned entry is removed → `tests/tools/initiative-propose.test.ts`
- Amendment cycle refused → `tests/initiatives/propose.test.ts`
- Planned change cannot be re-proposed → `tests/initiatives/propose.test.ts`
- Waiting on an open change → `tests/initiatives/readiness.test.ts`
- Ready after merge → `tests/initiatives/readiness.test.ts`
- Abandoned dependency → `tests/initiatives/readiness.test.ts`
- Cycle through an existing change → `tests/tools/new-dependency.test.ts`
- Self dependency → `tests/initiatives/graph.test.ts` + `tests/initiatives/propose.test.ts`
- Progress shown → `tests/hooks/phase-card.test.ts`
- Ready changes proposed → `tests/hooks/card-input.test.ts`
- Two open changes modify the same capability → `tests/initiatives/facts.test.ts` + `tests/hooks/phase-card.test.ts`
- Sibling merged → `tests/tools/change-sync.test.ts`
- Regression receipts → `tests/tools/change-sync.test.ts`
- Failing unit after the merge → `tests/tools/change-sync.test.ts`
- Regression during review → `tests/tools/change-sync.test.ts`
- Conflict → `tests/tools/change-sync.test.ts`
- Over the unit limit → `tests/tools/spec-gate.test.ts`
- Waived → `tests/tools/spec-gate.test.ts`
- Split with a dependency on a unit that stays → `tests/tools/change-split.test.ts`
- Split brings the capability count within limits → `tests/initiatives/split.test.ts`
- Split during build returns to plan → `tests/tools/change-split.test.ts`
- Split refused while parked → `tests/initiatives/split.test.ts`
- Split refused when a remaining unit depends on a moved one → `tests/initiatives/split.test.ts`
- Started unit cannot move → `tests/initiatives/split.test.ts`

### discovered-dependencies
- Gate sent with default A → `tests/tools/new-dependency.test.ts`
- Split offered at the finished boundary → `tests/tools/new-dependency.test.ts`
- Option A without an initiative → `tests/tools/new-dependency.test.ts`
- Option A inside an initiative → `tests/tools/new-dependency.test.ts`
- Option B → `tests/tools/new-dependency.test.ts`
- Option D back to shape → `tests/tools/new-dependency.test.ts`
- Follow-up of B ends with the amendment → `tests/engine/next-step.test.ts`
- Counter shown → `tests/engine/deps-facts.test.ts`
- Cap exceeded → `tests/engine/deps-facts.test.ts` + `tests/tools/new-dependency.test.ts`
- Option D does not count → `tests/engine/deps-facts.test.ts`
- Two lanes in progress → `tests/tools/change-park.test.ts`
- Unit with no work is not branched → `tests/tools/change-park.test.ts`
- Rerun after a failed push → `tests/tools/change-park.test.ts`
- Card while waiting → `tests/hooks/phase-card.test.ts`
- Abandoned prerequisite removed → `tests/engine/next-step.test.ts`
- Resume proposed → `tests/engine/next-step.test.ts`
- Resume with two lanes keeps all work → `tests/tools/change-resume.test.ts` + `tests/e2e/initiative-flow.test.ts`
- Prerequisite not merged → `tests/tools/change-resume.test.ts`
- Finished unit regresses → `tests/tools/change-resume.test.ts`

### change-tools
- Dirty tree, Already started → existing `tests/tools/change-start.test.ts`
- Dependency not merged, Dependency merged, Abandoned dependency → `tests/tools/change-start.test.ts`

### subagent-dispatch
- Missing required source, Needs context capped, Crash retried once → existing `tests/subagents/dispatch.test.ts`
- Missing prerequisite opens the dependency gate, Missing prerequisite past the cap → `tests/tools/subagent-dispatch.test.ts` (+ inline path in `tests/tools/subagent-record.test.ts`)

### command-guards
- No tool calls the push path → `tests/guard/push-callers.test.ts`
- Refspec from the issue → existing `tests/tools/change-ship.test.ts`
- Refspec from the fix branch → existing `tests/guard/push-callers.test.ts`
- Refspec of a wip branch → `tests/guard/push-callers.test.ts`

### change-close
- Pull request closed unmerged, Abandoned change has nothing left to do → existing `tests/engine/next-step.test.ts`
- Abandon → existing `tests/tools/change-close.test.ts`
- Drop after a discovered dependency, Abandon refused without a pull request or drop → `tests/tools/change-close.test.ts`

### flow-pack
- Default pack loads, Default pack contents, Spot check → `tests/engine/pack-load.test.ts`

### context-injection
- Card contents, Stale card, Registered section, Pending approvals shown, Ignored command shown, Evidence shown → existing `tests/hooks/phase-card.test.ts`
- Parked and initiative lines → `tests/hooks/phase-card.test.ts`

### flow-engine
- No unit ready, Last phase, Blocking question first, Missing output, Not started, Next unit, Human gate ready, Pending gate request, Stuck report first, Frozen unit, Dismissed gate, Ship approved, Blocked unit asks for a stuck report, Started unit before the next unit, Review round before the gate, Waived check does not hold the next step, Review approval at an older HEAD, Clean merge keeps the approval, Merge seen before checks, Merge seen in review → existing `tests/engine/next-step.test.ts` (must still pass after renumbering)
- Parked change waits, Not started with an unmet dependency, Park before finishing a started unit, Sync before the next unit → `tests/engine/next-step.test.ts`
- Counter shown with cap, Derived discovered dependencies → `tests/engine/counters.test.ts` + `tests/engine/deps-facts.test.ts`
- Derived review rounds, Counter update edits in place, Derived iteration count, Derived unit attempts → existing `tests/engine/counters.test.ts` / `next-step.test.ts`

### phase-gates
- Blocking question keeps the gate closed, Failing check that is not waivable, Gate-only check runs at the gate, Forge answer completed without rerunning gate-only checks, Self gate, Registered gate, Named gate option recorded, Named gate option does not waive → existing `tests/tools/spec-gate.test.ts` / `tests/interaction/complete.test.ts`
- Gate with a proposer, Parked change refuses the plan gate, Proposer gate survives work in progress → `tests/tools/spec-gate.test.ts`
- Forge answer on a parked change → `tests/interaction/complete.test.ts`
- Gate effect runs once before the result, Validator supersedes, No effect on changes requested → `tests/interaction/complete.test.ts`

### unit-evidence
- Red at pre starts the unit, Green at pre is refused, Refactor unit must pass at pre, Dirty tree, Frozen unit, Unmet dependency, One started unit at a time, Started in a lane, Rebuild starts green, Restart after an amendment → existing `tests/tools/unit-start.test.ts`
- Parked change refuses, Resumed unit starts green → `tests/tools/unit-start.test.ts` (+ `tests/tools/change-resume.test.ts`)
