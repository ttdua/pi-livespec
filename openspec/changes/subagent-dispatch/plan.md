# Subagent Dispatch Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Dispatch livespec role work (scout, implementer, reviewer, verifier) to the executor service with a four-layer brief, record results on the forge, run independent units in parallel lanes, and keep the same flow inline without an executor.

**Architecture:** A new `src/subagents/` module, one responsibility per file (design D1):
- an adapter for the executor service;
- pure policy, packet and record functions;
- tools in `src/tools/` that compose them.

Child sessions are detected in the existing hooks. `unit_start` and `unit_finish` gain lane and finding checks. Nothing calls a model or a router directly.

**Tech Stack:** TypeScript (ESM, `.ts` imports), Bun, Vitest, `yaml` for pack nodes, the pi ExtensionAPI, `@ttdua/pi-subagents` service contract (pi-jev-pilot 0.5.0) through a structural type only (no package dependency).

## Global Constraints

- livespec never passes `model` and never `context: "fork"`. Every launch passes `context: "fresh"` and `contextFiles: false`.
- Executor detection is by capability: `spawn`, `wait`, `resume`, `abort`, `childSession`, `getAgentType`. It never checks the package name or version.
- Service keys, in order: `Symbol.for("@ttdua/pi-subagents:service")`, then the legacy `Symbol.for("@gotgenes/pi-subagents:service")`.
- No new npm dependency. No agent files shipped. No workspace provider registered.
- User config defaults: `lanes: 3`, `packetBudgetTokens: 24000`. Token estimate = `ceil(chars / 4)`.
- Spill directory: `<git common dir>/livespec/packets/<change>/<hash>/`. The hash is computed with spill paths written as `<spill>/<file>`.
- `context>=N%` holds at usage ≥ N−2, never before the first completed turn.
- Retry and cap constants:
  - missing structured result: retry 1;
  - missing required source: return 1;
  - `NEEDS_CONTEXT`: at most 2 per unit;
  - fix rounds: `unit_rebuilds` (pack, default 2).
- Repository content is in English. Every new file starts with a one-line purpose comment, as existing files do.

## Review Focus

1. **An executor that drops an option silently.** Expect the post-launch check to abort, not to run in the wrong environment. Task 6 adds a test per effective field: `context`, `cwd`, `inheritSkills`, `skillPaths`, `contextFiles`, `excludedExtensionPackages`.
2. **A `session-created` event that never arrives** (old executor, or a run that fails before the session exists). Expect a mismatch, not a hang. Task 6 adds `dispatch treats a missing session-created as a mismatch`.
3. **A skill missing from the content tree after a flow switch or rollback.** Expect a refusal naming the skill before any spawn. Task 5 adds `packet refuses a role skill missing from the tree`.
4. **A pre-existing lane worktree or branch left by a crash.** Expect it to be reused when its HEAD is the change branch HEAD, and refused with its path otherwise. Task 8 adds `lane reuses a clean leftover worktree and refuses a diverged one`.
5. **The parent session compacts or reloads while a child is waiting on a question.** Expect the question to survive through the record, and `subagent_answer` to still find the child. Task 6 adds `subagent_answer finds a pending child after a session reload`; the pending child is a `dispatch` record with status `QUESTION` on the forge, not session memory.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `SubagentsServiceLike` | new | `{ spawn(type: string, prompt: string, o: SpawnOptionsLike): string; wait(id: string, o?: { signal?: AbortSignal }): Promise<RecordLike>; resume(id: string, prompt: string): Promise<unknown>; abort(id: string): boolean; childSession(sessionId: string): { agentId: string; agentType: string; metadata: Readonly<Record<string,string>> } \| undefined; getAgentType(name: string): { name: string; source: string; filePath?: string } \| undefined }`: structural, in `src/subagents/executor.ts` | no |
| `SpawnOptionsLike` | new | `{ description: string; context: "fresh"; contextFiles: false; thinkingLevel: "low"\|"medium"\|"high"; metadata: Record<string,string>; skills: { inherit: false; paths: string[] }; excludeExtensionPackages: string[]; cwd: string; resultSchema: JsonSchema }` | no |
| `RecordLike` | new | `{ id: string; status: string; result?: string; error?: string; pendingQuestion?: { text: string }; structuredResult?: unknown; structuredResultError?: "missing"\|"invalid" }` | no |
| `LaunchFacts` | new | `{ context: string; cwd: string; inheritSkills?: boolean; skillPaths?: string[]; contextFiles?: boolean; excludedExtensionPackages?: string[]; effectiveModel?: string; effectiveThinking?: string }` | no |
| `SERVICE_KEYS` | new | `readonly ["@ttdua/pi-subagents:service", "@gotgenes/pi-subagents:service"]`, read in order with `Symbol.for` | no |
| `findExecutor()` | new | `() => { ok: true; service: SubagentsServiceLike; key: string } \| { ok: false; missing: string[] }` | no |
| `isChildSession(ctx)` | new | `(ctx: { sessionManager: { getSessionId(): string; getHeader(): { parentSession?: string } \| undefined } }) => boolean` | no |
| `CHILD_NOTE` | new | `string` constant in `src/subagents/child.ts` | no |
| `Role` / `ReviewSubject` | new | `"scout"\|"implementer"\|"reviewer"\|"verifier"` / `"spec"\|"plan"\|"unit"\|"change"\|\`persona:${string}\`` | no |
| `SubagentEntry` | new | `{ role: Role; subject?: ReviewSubject; mode: "off"\|"always"\|"auto"; when?: string[]; advisory?: boolean; skills?: string[] }`: pack `phases[].subagents[]` | yes (flow pack format) |
| `Finding` | new | `{ severity: "CRITICAL"\|"WARNING"\|"SUGGESTION"; kind: "defect"\|"missed-context"\|"lowered-standard"\|"files-violation"\|"other"; location: string; evidence: string; fix: string; scope: "unit"\|"in-change"\|"out-of-scope"\|"needs-decision" }` | yes (review output) |
| `SubagentResult` | new | `{ status: "DONE"\|"DONE_WITH_CONCERNS"\|"BLOCKED"\|"NEEDS_CONTEXT"; notes: string; discoveries: string[]; sources_used: string[]; reason?: string; evidence?: string; commits?: string[]; findings?: Finding[] }` | yes (result schema) |
| `dispatch` marker data | new | `{ role; unit?; subject?; agentId?: string; attempt: number; packet: string; agentSource: string; requested: { thinking }; effective: { model?; thinking? }; status; commits: string[]; notes: string; discoveries: string[]; sources_used: string[] }` | yes (forge record) |
| `finding-summary` marker data | new | `{ role; subject; unit?; agentId?: string; round: number; status; advisory: boolean; head: string; packet: string; sources_used: string[]; required: string[]; completed: boolean; agentSource; requested; effective; findings: Finding[] }`, or a rebuttal `{ rebuts: string; items: { index: number; reason: string; evidence: string }[] }` | yes (forge record) |
| `Packet` | new | `{ text: string; hash: string; sources: { id: string; version: string; required: boolean; spill?: string }[]; skillPaths: string[]; cwd: string }` | no |
| `registerPacketSource(role, provider)` | new | `(role: Role, provider: (ctx: PacketContext) => Promise<PacketSource[]>) => void` | yes (extension seam) |
| `PacketSource` | new | `{ id: string; version: string; title: string; text: string; untrusted: boolean; required: boolean }` | yes |
| Tool `subagent_dispatch` | new | params `{ role: Role; unit?: string; subject?: ReviewSubject }` | yes |
| Tool `subagent_answer` | new | params `{ id: string; answer: string }` | yes |
| Tool `subagent_packet` | new | params `{ role: Role; unit?: string; subject?: ReviewSubject }`, returns the packet text and skill paths | yes |
| Tool `subagent_record` | new | params `{ role: Role; unit?: string; subject?: ReviewSubject; result: SubagentResult }` | yes |
| Tool `finding_rebut` | new | params `{ comment: string; index: number; reason: string; evidence: string }` | yes |
| Tool `forge_read` | new | params `{ target: "issue"\|"comments"\|"pr"\|"pr-files"\|"reviews"\|"review-comments"\|"checks"\|"search"; number?: number; ref?: string; labels?: string[]; text?: string }` | yes |
| `lane` marker data | new | `{ unit: string; path: string; branch: string; base: string; closed?: true }`; marker id `lane.<unit>` | yes (forge record) |
| `dispatch` status `QUESTION` / `ANSWERED` | new | `dispatch` data with `status: "QUESTION"; role; agentId: string; question: string`, or `status: "ANSWERED"; role; agentId: string; answer: string`. Every `dispatch` and `finding-summary` record of a launched run carries `agentId` | yes (forge record) |
| Marker ids | new | `dispatch.<unit|change>.<role>.<attempt>`, `finding-summary.<unit|change>.<subject>.<round>`, `finding-summary.rebut.<commentId>` | yes |
| `ChangeState.subagents` | new | `{ executor: { ok: boolean; missing: string[] }; contextPercent?: number; turnsCompleted: number; lanes: Record<string, LaneRecord>; pending?: { unit?: string; agentId: string; question: string } }`, filled at refresh | no |
| `NextStep.dispatch` / `NextStep.pendingChild` | new | `dispatch?: { role: Role; unit?: string; subject?: ReviewSubject; inline: boolean }`; `pendingChild?: { agentId: string; question: string }` | no |
| `Git.worktreeAddBranch` / `Git.resetHard` | new | `worktreeAddBranch(dir: string, branch: string, at: string): Promise<void>` → `git worktree add -b <branch> <dir> <at>`; `resetHard(sha: string): Promise<void>` → `git reset --hard <sha>` | no |
| `unitRoot(state, unit)` | new | `(state: ChangeState, unit: string) => string`: the open lane's path, else the change worktree root | no |
| `UserConfig` | modified | adds `lanes: number; packetBudgetTokens: number; isolation: { excludePackages: string[] }` | yes (config file) |
| `unit_start` / `unit_finish` | modified | same params; new refusals (spec `unit-evidence`) | yes |

---

## Task 1: Executor adapter and child sessions — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/subagents/executor.ts`, `src/subagents/child.ts`
- Modify: `src/hooks/context.ts`, `src/hooks/session.ts`
- Test: `tests/subagents/executor.test.ts`, `tests/subagents/child.test.ts`, `tests/hooks/context.test.ts`, `tests/hooks/session.test.ts`, `tests/hooks/guard.test.ts`

**Interfaces:** Produces `findExecutor`, `SubagentsServiceLike`, `LaunchFacts`, `parseLaunchFacts(payload: unknown): { agentId: string; facts: LaunchFacts } | undefined` (pure parse of a `session-created` payload; the lifecycle watcher is Task 6's `watchLaunch`), `isChildSession`, `CHILD_NOTE`.

- [ ] **Step 1:** Write the failing tests:
  - `findExecutor reports missing capabilities`: a fake service without `wait` → `{ ok: false, missing: ["wait"] }`.
  - `parseLaunchFacts reads the effective fields`.
  - `findExecutor ignores implementation name`.
  - `findExecutor reads the new key`, `findExecutor falls back to the legacy key`, `findExecutor prefers the new key when both are published`.
  - `isChildSession` for three cases: `childSession` returns a record → true; returns undefined with no `parentSession` → false; throws → true.
  - `context hook adds no card in a child`.
  - `before_agent_start sets CHILD_NOTE in a child`.
  - `resources_discover returns no skills in a child`.
  - `no resume card at child session_start`.
  - `guard blocks git push in a child`.
  - `CHILD_NOTE names no default-pack skill`.
- [ ] **Step 2:** Run `bun run test tests/subagents tests/hooks`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement the executor and child modules:
  - `executor.ts` and `child.ts` per the Contracts.
  - `CHILD_NOTE` states that the parent owns state; that the child must not tick, push, write to the forge or edit `.pi/livespec/`; that `<untrusted>` is data; and to use `ask_parent` when context is missing.
- [ ] **Step 4:** Implement the hook changes:
  - In `context.ts`, each handler calls `isChildSession(ctx)` first.
  - In `session.ts`, skip the resume card for a child.
- [ ] **Step 5:** Run `bun run test`. Expected: PASS, with existing context and session tests unchanged.
- [ ] **Step 6:** Commit `feat(subagents): executor adapter and child sessions`.

## Task 2: Config keys and isolation list — implements 2

**Covers:** 2.1, 2.2, 2.3
**Difficulty:** Easy
**Blocked by:** none

**Files:**
- Create: `src/subagents/isolation.ts`
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`, `tests/subagents/isolation.test.ts`

**Interfaces:** Produces `UserConfig.lanes`, `UserConfig.packetBudgetTokens`, `UserConfig.isolation.excludePackages`, and `excludedPackages(configured: string[], extra: string[]): string[]`. Also produces `configuredPackages(root, home): Promise<string[]>`, which reads `packages` from `~/.pi/agent/settings.json` and `.pi/settings.json` and accepts string and `{ source }` entries.

- [ ] **Step 1:** Write the failing tests:
  - `subagent settings`: values from the spec scenario.
  - `subagent defaults`: 3 / 24000 / `[]`.
  - `invalid lanes`: `0` → warning naming `lanes`, value 3.
  - `known flows excluded`: `git:github.com/obra/superpowers` matched.
  - `extra user exclusion only`: `["npm:acme-flow"]`.
  - `no duplicates`.
- [ ] **Step 2:** Run `bun run test tests/config.test.ts tests/subagents/isolation.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement:
  - Parse the new keys in `config.ts`, following the existing `verify` key pattern.
  - In `isolation.ts`, `KNOWN_FLOW_PATTERNS = [/(^|[:/])obra\/superpowers(@|$)/, /(^|[:/])ttdua\/pi-superspec(@|$)/]`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(subagents): subagent config keys and flow isolation`.

## Task 3: Roles, result schemas and policy — implements 3

**Covers:** 3.1, 3.2, 3.3, 3.4
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/subagents/roles.ts`, `src/subagents/policy.ts`
- Modify: `src/packs/agent-skills.yaml`, `tests/fixtures/agent-skills.pack.json`, `src/extension.ts` (side-effect import of `policy.ts`)
- Test: `tests/subagents/roles.test.ts`, `tests/subagents/policy.test.ts`, `tests/engine/pack-load.test.ts`

**Interfaces:**
- Consumes `registerPackSchema` from `src/engine/registry.ts`.
- Produces:
  - `AGENT_OF: Record<Role, string>` and `resultSchema(role): JsonSchema`;
  - `FINDING_SCHEMA`, `ROLE_SUBJECTS`;
  - `entriesFor(pack, phaseId): SubagentEntry[]`;
  - `holds(entry, facts: PolicyFacts): boolean`, where `PolicyFacts = { units: number; difficulty?: "low"|"medium"|"high"; maxDifficulty?: ...; tags: string[]; unfamiliar: boolean; contextPercent?: number; turnsCompleted: number }`;
  - `unfamiliarCode(phase, unit | undefined, specs): boolean`.

- [ ] **Step 1:** Write the failing tests:
  - `valid entry`.
  - `reviewer without subject`, with a line/column error.
  - `model key rejected`.
  - `when requires auto`.
  - `unfamiliar code in build`.
  - `unfamiliar code in plan`, for a capability without `paths`.
  - `context threshold with margin`: 58.5 against 60 → holds.
  - `first turn never holds`.
  - `resultSchema(implementer) requires commits`.
  - `resultSchema(reviewer) requires findings`.
  - `default pack build entries validate`.
- [ ] **Step 2:** Run `bun run test tests/subagents tests/engine/pack-load.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `roles.ts` as data. Schemas use only the executor's subset: `type`, `enum`, `properties`, `items`, `required`, `additionalProperties: false`.
- [ ] **Step 4:** Implement `policy.ts`. The validator walks the YAML node to report with line and column, and its `personas()` returns `persona:` subjects without the prefix.
- [ ] **Step 5:** Add the default entries to `agent-skills.yaml` exactly as spec `subagent-policy` "Default pack entries" lists them, and regenerate the JSON fixture the way `tests/engine/pack-load.test.ts` expects.
- [ ] **Step 6:** Run `bun run test`. Expected: PASS.
- [ ] **Step 7:** Commit `feat(subagents): roles, result schemas and the subagents pack policy`.

## Task 4: Records — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4
**Difficulty:** Hard
**Blocked by:** Task 3

**Files:**
- Create: `src/subagents/records.ts`, `src/subagents/state.ts`
- Modify: `src/engine/state-types.ts` (`ChangeState.subagents`, and the `NextStep.dispatch` / `NextStep.pendingChild` fields that Task 9 fills), `src/engine/snapshot.ts` (fill `ChangeState.subagents` at refresh)
- Test: `tests/subagents/records.test.ts`, `tests/subagents/state.test.ts`

**Interfaces:**
- Consumes `registerKind`, `writeMarked`, `parseMarked`, `MarkedComment` from `src/forge/markers.ts`; `Finding` and `SubagentResult` from Task 3; and `Git.parents`.
- Produces:
  - `dispatchComment(data)` and `latestDispatch(marked, unit)`;
  - `findingSummaryComment(data)` and `rebuttalComment(data)`;
  - `unresolvedBlocking(marked, unit, answered: Set<string>, gatesShown: Set<string>): { comment: string; index: number; finding: Finding }[]`;
  - `completedReviewAt(marked, unit, commits: string[]): boolean`, where `commits` is HEAD, plus the merge's second parent when HEAD is a lane merge;
  - `computeCompleted(result, required): boolean`;
  - `laneComment(data)`, `openLanes(marked): Record<string, LaneRecord>` and `unitRoot(state, unit)` in `state.ts`;
  - `pendingQuestion(marked): { unit?; role; agentId; question } | undefined`: a `dispatch` record with status `QUESTION` is pending until a later `dispatch` record with status `ANSWERED` and the same `agentId` (posted by `subagent_answer` before resuming) or a later record of any kind carrying the same `agentId` (`dispatch` or `finding-summary`).

- [ ] **Step 1:** Write the failing tests, one per `review-findings` scenario and the record scenarios:
  - `blocked round resolves nothing`;
  - `advisory unit review not blocking`;
  - `rebutted warning resolved`;
  - `missed-context not resolvable by rebuttal`;
  - `needs-decision resolved after answer`;
  - `lane head accepted as second parent`;
  - `incomplete review does not count`;
  - `dispatch marker kind registered`;
  - `lane record open and closed`;
  - `unitRoot returns the open lane, else the change root`;
  - `pending question survives a reload` (rebuilt from comments only);
  - `answered question of a reviewer is closed` (QUESTION → ANSWERED → `finding-summary` with the same `agentId`).
- [ ] **Step 2:** Run `bun run test tests/subagents/records.test.ts tests/subagents/state.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. The rules for each query:
  - Resolution matches findings by `location` and `kind`, using the latest completed round of the same unit and subject.
  - Records are append-only, and the latest own comment wins.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(subagents): dispatch and finding-summary records`.

## Task 5: Packets — implements 5

**Covers:** 5.1, 5.2, 5.3, 5.4, 5.5
**Difficulty:** Very Hard
**Blocked by:** Task 2, Task 3, Task 4

**Files:**
- Create: `src/subagents/protocol.ts`, `src/subagents/sources.ts`, `src/subagents/packet.ts`, `src/subagents/freshness.ts`
- Test: `tests/subagents/protocol.test.ts`, `tests/subagents/sources.test.ts`, `tests/subagents/packet.test.ts`, `tests/subagents/freshness.test.ts`

**Interfaces:**
- Consumes:
  - from Task 2: `UserConfig.packetBudgetTokens`;
  - from Task 3: `entriesFor`, `AGENT_OF`;
  - from Task 4: `latestDispatch`;
  - from the existing code: `untrusted()` (`src/hooks/phase-card.ts`), `ChangeState`, `Session.activeTree`, `Forge`, and `Git.diff`.
- Produces:
  - `PROTOCOL_VERSION` and `protocolText(): string`;
  - `registerPacketSource`;
  - `buildPacket(ctx: PacketContext, role, unit?, subject?): Promise<{ ok: true; packet: Packet } | { ok: false; message: string }>`, where `PacketContext = { session, state, pack, forge, git, root, cwd, budgetTokens }`;
  - `roleSkillPaths(pack, phase, role, tree): { ok: true; paths } | { ok: false; missing }`;
  - `checkFreshness(packet, current): { stale: string[] }`.

- [ ] **Step 1:** Write the failing tests:
  - `stable prefix`: U1 and U2 packets are byte-equal up to `## Task`.
  - `prohibitions present`.
  - `protocol names no default-pack skill`.
  - `implementer default skills`: the three build skills.
  - `reviewer skills from the pack`.
  - `flow switch changes skill paths and hash`.
  - `answered question included`: Q2 mentioning a `Files` path.
  - `spec review sees the diff`.
  - `diff as a file`.
  - `same inputs same hash`.
  - `comment edited changes hash`.
  - `over budget spills`.
  - `budget too small refuses`.
  - `instruction in a comment wrapped untrusted`.
  - `registered provider adds source`.
  - `packet refuses a role skill missing from the tree`.
  - `new human comment stops`.
  - `new answer recorded by the plugin stops`.
  - `own receipt passes`.
- [ ] **Step 2:** Run `bun run test tests/subagents`. Expected: FAIL.
- [ ] **Step 3:** Implement `protocol.ts`: a constant text plus the version, with the content from spec "Protocol content".
- [ ] **Step 4:** Implement `sources.ts`. There is one provider function per manifest line in spec "Context manifest", keyed by role and subject. Versions come from the forge `updatedAt`, a git SHA or a SHA-256 of the content.
- [ ] **Step 5:** Implement `packet.ts`:
  - layer order per design D3;
  - spill in reverse manifest order until `ceil(chars/4) <= budget`;
  - hash with the `<spill>/` placeholder, then substitute the directory;
  - files written under `git rev-parse --git-common-dir`.
- [ ] **Step 6:** Implement `freshness.ts` per spec "Freshness before finish".
- [ ] **Step 7:** Run `bun run test`. Expected: PASS.
- [ ] **Step 8:** Commit `feat(subagents): packets, sources and freshness`.

## Task 6: Dispatch and tools — implements 6

**Covers:** 6.1, 6.2, 6.3, 6.4
**Difficulty:** Very Hard
**Blocked by:** Task 1, Task 2, Task 4, Task 5, Task 7, Task 9 (single writer of `change-tools.ts`: Tasks 7 and 9 export `registerFindingRebut` and `registerForgeRead`)

**Files:**
- Create: `src/subagents/launch.ts` (spawn options, launch-facts watcher, post-launch check), `src/subagents/result.ts` (pure result interpretation), `src/subagents/dispatch.ts` (orchestration only), `src/tools/subagent-dispatch.ts`, `src/tools/subagent-answer.ts`, `src/tools/subagent-packet.ts`, `src/tools/subagent-record.ts`
- Modify: `src/tools/change-tools.ts` (registers every new tool of Tasks 6, 7 and 9: this task is the only writer of that file)
- Test: `tests/subagents/dispatch.test.ts`, `tests/tools/subagent-dispatch.test.ts`, `tests/tools/subagent-answer.test.ts`, `tests/tools/subagent-record.test.ts`

**Interfaces:**
- Consumes everything from Tasks 1, 2, 4, 5, 7 and 9.
- Produces:
  - `launch.ts`: `spawnOptions(packet, role, entry, difficulty, attempts, exclusions, metadata): SpawnOptionsLike`; `watchLaunch(events, signal): { factsFor(agentId: string): Promise<LaunchFacts | undefined>; dispose(): void }`: subscribes to `subagents:child:session-created` **before** `spawn`, buffers events by agent id, and resolves `undefined` once the run settles or the signal aborts; `checkLaunch(requested, facts?): { ok: true } | { ok: false; field: string; laneCwd: boolean }`;
  - `result.ts`: `interpret(record: RecordLike, packet: Packet, role: Role, history: DispatchHistory): ResultDecision`, pure, where `ResultDecision = { kind: "accept"; result } | { kind: "retry" } | { kind: "return"; missing: string[] } | { kind: "more-context"; ids: string[] } | { kind: "question"; text } | { kind: "blocked"; reason } | { kind: "stuck"; reason }`, and `DispatchHistory` is read from `dispatch` records;
  - `runDispatch(deps, request): Promise<DispatchOutcome>`, where `DispatchOutcome = { kind: "result"; result: SubagentResult; facts: LaunchFacts } | { kind: "question"; id: string; text: string } | { kind: "inline"; reason: string; packet: Packet } | { kind: "sequential"; reason: string } | { kind: "blocked"; reason: string } | { kind: "stuck"; reason: string }`.

- [ ] **Step 1:** Write the failing tests. Each uses a fake service that records `spawn` options and emits `session-created`. One per `subagent-dispatch` scenario:
  - `capable executor launches`.
  - `missing capability runs inline`.
  - `renamed package launches`.
  - `unit role without a unit refuses`.
  - `called in a child refuses`.
  - `user override used with one warning`.
  - `disabled role agent runs inline`.
  - `implementer launch options`: exact fields; no `model`.
  - `superpowers excluded`.
  - `extra user exclusion`.
  - `raised after a failure`.
  - `routed by another layer recorded`.
  - `skills ignored aborts`.
  - `exclusion ignored aborts`.
  - `context forced to fork returns refusal`.
  - `blocked without evidence treated as missing`.
  - `missing required source returned once then BLOCKED`.
  - `needs context capped at 2`.
  - `crash retried once with identical hash`.
  - `ask and answer`.
  - `question for the user goes to spec_question`.
  - `pending question on the card`.
  - `inline review recorded`.
  - `discoveries reach the dependent unit`.
  - `dispatch treats a missing session-created as a mismatch`.
  - `subagent_answer finds a pending child after a session reload`;
  - `session-created emitted during spawn is not missed`;
  - `no executor`: the dispatch returns the inline packet and the instructions to finish with `subagent_record`, and the receipt is the same as for a dispatched run.
- [ ] **Step 2:** Run `bun run test tests/subagents/dispatch.test.ts tests/tools`. Expected: FAIL.
- [ ] **Step 3:** Implement `launch.ts`:
  - thinking = `Difficulty`, raised one step per failed attempt, capped at `high`;
  - metadata keys: `owner`, `change`, `role`, `packet`, `unit`, `subject`, `lane`, `difficulty`.
- [ ] **Step 4:** Implement `result.ts` (spec "Result handling") and `dispatch.ts`. The `dispatch.ts` order is:
  1. `watchLaunch` (uses Task 1's `parseLaunchFacts`);
  2. `spawn`;
  3. race `factsFor` against `wait`, then `checkLaunch` (`abort` on failure);
  4. `wait`;
  5. `interpret`.

  A `question` decision posts a `dispatch` record with status `QUESTION`; `subagent_answer` posts `ANSWERED` before `resume`. Counters come from `dispatch` records only.
- [ ] **Step 5:** Implement the four tools, and register them plus `finding_rebut` (Task 7) and `forge_read` (Task 9) in `change-tools.ts`, whose registration functions those tasks export:
  - Each refuses in a child.
  - Each posts the `dispatch` or `finding-summary` record through `prepareWrite`.
  - `subagent_record` validates the result against `resultSchema(role)` with a small subset validator in `roles.ts`.
- [ ] **Step 6:** Run `bun run test`. Expected: PASS.
- [ ] **Step 7:** Commit `feat(subagents): dispatch, answer, packet and record tools`.

## Task 7: Findings tool and unit evidence — implements 7

**Covers:** 7.1, 7.2, 7.3, 7.4
**Difficulty:** Hard
**Blocked by:** Task 4, Task 5 (freshness is called from `unit_finish`)

**Files:**
- Create: `src/tools/finding-rebut.ts`
- Modify: `src/tools/unit-finish.ts`, `src/tools/unit-start.ts`, `src/tools/unit-tool.ts` (`finding-rebut.ts` exports `registerFindingRebut`; Task 6 registers it)
- Test: `tests/tools/finding-rebut.test.ts`, `tests/tools/unit-finish.test.ts`, `tests/tools/unit-start.test.ts`

**Interfaces:**
- Consumes `unresolvedBlocking`, `completedReviewAt` and `rebuttalComment` (Task 4); `entriesFor` and `holds` (Task 3).
- Consumes `unitRoot` (Task 4) and `checkFreshness` (Task 5).

- [ ] **Step 1:** Write the failing tests:
  - `rebutted warning`;
  - `rebut missed-context refused`;
  - `rebut without evidence refused`;
  - `unresolved blocking finding refuses finish`;
  - `review required but not run`;
  - `lane review accepted after merge`;
  - `incomplete review does not count`;
  - `receipted unit with a new blocking finding`;
  - `started in a lane`;
  - `one started unit at a time` (adjusted to the same worktree);
  - `new human comment stops unit_finish` (freshness through the tool).
- [ ] **Step 2:** Run `bun run test tests/tools/unit-*.test.ts tests/tools/finding-rebut.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the checks in `unit-finish.ts`, which run before the receipted-not-ticked branch:
  - **Finding check:** evaluates the policy without `context>=` conditions.
  - **Freshness check:** for a unit with a `dispatch` record, `checkFreshness` against the packet's sources. A stale result posts the `stuck` report through the existing `spec_stuck` writer and refuses the tick.
- [ ] **Step 4:** Implement the lane changes. `unit-tool.ts` resolves the worktree with `unitRoot(state, unit)` (the open `lane` record, else the change root) for the dirty-tree, HEAD and `Verify` checks. `unit-start.ts` refuses only when another unit is started in the same worktree.
- [ ] **Step 5:** Run `bun run test`. Expected: PASS, with every existing unit test unchanged except "One started unit at a time".
- [ ] **Step 6:** Commit `feat(unit-evidence): finding and lane checks in unit_start and unit_finish`.

## Task 8: Parallel lanes — implements 8

**Covers:** 8.1, 8.2, 8.3
**Difficulty:** Very Hard
**Blocked by:** Task 6, Task 7

**Files:**
- Create: `src/subagents/lanes.ts`
- Modify: `src/engine/git.ts` (add `worktreeAddBranch` and `resetHard`, see Contracts)
- Test: `tests/subagents/lanes.test.ts` (temporary git repos via `tests/helpers/repo.ts`)

**Interfaces:**
- Consumes `Git`, `runDispatch`, `laneFor`, `unit_finish` internals, and `dispatchComment`.
- Produces:
  - `eligibleLanes(state, max): string[][]`;
  - `openLane(git, change, unit): Promise<{ ok: true; path } | { ok: false; message }>`;
  - `mergeLane(git, lane): Promise<"ok" | "conflict">`;
  - `filesViolation(git, lane, files): Promise<string[]>`;
  - `closeLane(git, lane): Promise<void>`.

- [ ] **Step 1:** Write the failing tests:
  - `overlapping files not parallel`;
  - `lane limit`;
  - `lane created at path and branch`;
  - `two lanes merge one at a time`;
  - `files violation re-runs sequentially and posts files-violation`;
  - `red after merge undoes and counts an attempt`;
  - `moved by a workspace provider re-runs sequentially`;
  - `lane reuses a clean leftover worktree and refuses a diverged one`.
- [ ] **Step 2:** Run `bun run test tests/subagents/lanes.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement:
  - `openLane` posts the `lane` record after the worktree exists.
  - `mergeLane` closes the record before `unit_finish` runs on the change root.
  - To undo a red merge, run `Git.resetHard(<pre-merge HEAD>)` on the change branch. It is safe because the tree was clean, and that is checked before the merge.
- [ ] **Step 4:** Run `bun run test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(subagents): parallel lanes`.

## Task 9: Phase card, build loop and forge_read — implements 9

**Covers:** 9.1, 9.2, 9.3, 9.4
**Difficulty:** Hard
**Blocked by:** Task 3, Task 4 (Task 6 dropped: the next step reads `ChangeState.subagents` and records only, and Task 6 registers `forge_read`)

**Files:**
- Create: `src/tools/forge-read.ts`, `src/subagents/card.ts` (card section)
- Modify: `src/engine/next-step.ts`, `src/engine/gate-payload.ts`, `src/extension.ts` (`forge-read.ts` exports `registerForgeRead`; Task 6 registers it)
- Test: `tests/engine/next-step.test.ts`, `tests/engine/gates.test.ts`, `tests/tools/forge-read.test.ts`, `tests/subagents/card.test.ts`

**Interfaces:**
- Consumes `entriesFor` and `holds` (Task 3), the records queries and `ChangeState.subagents` (Task 4).
- Fills `NextStep.dispatch` and `NextStep.pendingChild` (declared by Task 4), and produces `registerForgeRead`.

- [ ] **Step 1:** Write the failing tests:
  - `auto implementer suggested`;
  - `below the threshold inline`;
  - `small-fix lane suggests nothing`;
  - `advisory spec review in gate payload`;
  - `review before finish`;
  - `rebuild cap → spec_stuck`;
  - `no executor → subagent_packet and subagent_record`;
  - `rebuttals in gate payload`;
  - `read comments`;
  - `unknown target refused`;
  - `human comment untrusted`;
  - `forge_read refuses in a child`;
  - `started unit without dispatch record → implementer step`;
  - `started unit with blocking finding → fix round`;
  - `fix commit → new review, then finish` (implement → blocking review → fix commit → review covers new HEAD → `unit_finish`).
- [ ] **Step 2:** Run `bun run test tests/engine tests/tools/forge-read.test.ts tests/subagents/card.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the next step:
  - **Replace** rule `startedUnit` with a build-loop rule. For a started unit it returns, in order:
    1. the pending child question;
    2. the implementer step (dispatch or inline) when no `dispatch` record exists for the current attempt;
    3. the unit review when the entry holds and no completed review covers the reviewed commit (HEAD, or the merged lane head), including after a fix commit;
    4. a fix round when the completed review that covers that commit has an unresolved blocking finding, or `spec_stuck` once `unit_rebuilds` rounds are used;
    5. otherwise `unit_finish`.
  - `nextStep` stays pure: it reads `ChangeState.subagents`.
- [ ] **Step 4:** Implement the gate payload: advisory findings and rebuttals listed under a "Subagent findings" heading.
- [ ] **Step 5:** Implement `forge_read` over `Forge` read methods only. A test asserts that no write method of the fake forge is called.
- [ ] **Step 6:** Run `bun run test`. Expected: PASS.
- [ ] **Step 7:** Commit `feat(subagents): build-loop next steps, gate payload and forge_read`.

## Task 10: Doctor, docs and end-to-end — implements 10

**Covers:** 10.1, 10.2, 10.3, 10.4
**Difficulty:** Hard
**Blocked by:** Task 1, Task 2, Task 6, Task 8, Task 9

**Files:**
- Create: `src/subagents/doctor.ts`, `tests/subagents/doctor.test.ts`, `tests/e2e/subagent-build.test.ts`
- Modify: `src/extension.ts`, `docs/architecture.md`, `README.md`

**Interfaces:** Consumes `registerDoctorCheck`, `findExecutor`, `configuredPackages` and `excludedPackages`.

- [ ] **Step 1:** Write the failing tests:
  - `executor missing`;
  - `executor lacks wait`;
  - `role override reported as information`;
  - `workspace provider package warns`;
  - `excluded packages listed`.
  - e2e: `five units complete with dispatches and lanes`;
  - e2e: `context threshold moves next unit to a subagent`;
  - e2e: `same change completes inline without executor`.
- [ ] **Step 2:** Run `bun run test tests/subagents/doctor.test.ts tests/e2e/subagent-build.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `doctor.ts`. The workspace-provider package list is `["npm:@gotgenes/pi-subagents-worktrees"]`.
- [ ] **Step 4:** Make the e2e tests pass with the fake executor and a temporary repository with a fake forge (existing `tests/e2e` helpers).
- [ ] **Step 5:** Update the docs:
  - `docs/architecture.md`: subagents section (the four layers, dispatch, child mode, lanes, records).
  - `README.md`: executor setup, model and effort with and without Jev, and a note on removing `@gotgenes/pi-subagents-worktrees`.
- [ ] **Step 6:** Run `bun run typecheck && bun run test && openspec validate subagent-dispatch`. Expected: all exit 0.
- [ ] **Step 7:** Commit `feat(subagents): doctor checks, docs and end-to-end coverage`.

---

## Scenario → test

**child-sessions**
- Child of the executor → `tests/subagents/child.test.ts` "isChildSession: record → true"
- Main session → `tests/subagents/child.test.ts` "isChildSession: no record, no parent → false"
- Check fails → `tests/subagents/child.test.ts` "isChildSession: throws → true"
- Child launched by the main agent → `tests/hooks/context.test.ts` "before_agent_start sets CHILD_NOTE in a child"
- Guard in a child → `tests/hooks/guard.test.ts` "guard blocks git push in a child"
- No skills from livespec → `tests/hooks/context.test.ts` "resources_discover returns no skills in a child"

**context-injection**
- Identical every turn → existing `tests/hooks/routing-note.test.ts`
- Child session gets the child note → `tests/hooks/context.test.ts` "before_agent_start sets CHILD_NOTE in a child"
- Appended at the end → existing `tests/hooks/context.test.ts`
- Cache prefix stable over five turns → existing `tests/hooks/context.test.ts`
- No card in a child session → `tests/hooks/context.test.ts` "context hook adds no card in a child"
- Resume mid-change, Other branch, Product pointer, Forge unavailable → existing `tests/hooks/session.test.ts`
- Child session start → `tests/hooks/session.test.ts` "no resume card at child session_start"

**forge-read**
- Read comments → `tests/tools/forge-read.test.ts` "read comments"
- Unknown target → `tests/tools/forge-read.test.ts` "unknown target refused"
- Human comment → `tests/tools/forge-read.test.ts` "human comment untrusted"
- Called by a child → `tests/tools/forge-read.test.ts` "forge_read refuses in a child"

**init-and-doctor**
- Unknown key, Interaction adapter list, Unknown adapter name, Verify settings, Invalid verify timeout → existing `tests/config.test.ts`
- Subagent settings, Subagent defaults, Invalid lanes → `tests/config.test.ts` (Task 2)
- Duplicate skill … Superpowers in a trusted project (11 existing) → existing `tests/commands/doctor*.test.ts`
- Executor missing, Executor lacks a capability, Role override, Workspace provider package, Excluded packages listed → `tests/subagents/doctor.test.ts`

**parallel-lanes**
- Overlapping files, Lane limit, Lane created, Two lanes finish, Files violation, Red after merge, Moved by a workspace provider → `tests/subagents/lanes.test.ts` (same names)

**review-findings**
- Valid finding, Missing location → `tests/subagents/roles.test.ts` "finding schema accepts six fields" / "rejects missing location"
- Needs a decision → `tests/subagents/records.test.ts` "needs-decision resolved after answer" and `tests/subagents/dispatch.test.ts` "needs-decision finding routes to spec_question"
- Unit review recorded → `tests/subagents/dispatch.test.ts` "finding-summary posted after review"
- Rebutted warning, Missed context, Rebut without evidence → `tests/tools/finding-rebut.test.ts`
- Fixed and re-reviewed, Blocked round resolves nothing, Advisory unit review → `tests/subagents/records.test.ts`

**subagent-dispatch**
- New service key, Legacy service key, Both keys published → `tests/subagents/executor.test.ts` (Task 1 names)
- Every scenario → `tests/subagents/dispatch.test.ts` or `tests/tools/subagent-*.test.ts`, with test names as listed in Task 6 Step 1 ("No executor" → `no executor`, plus `tests/e2e/subagent-build.test.ts` "same change completes inline without executor")
- Marker kind registered → `tests/subagents/records.test.ts` "dispatch marker kind registered"

**subagent-packets**
- Every scenario → `tests/subagents/{protocol,packet,sources,freshness}.test.ts`, with test names as listed in Task 5 Step 1

**subagent-policy**
- Valid entry, Reviewer without subject, Model key, Unfamiliar code in build, Context threshold with margin, First turn → `tests/subagents/policy.test.ts`
- Auto implementer, Below the threshold, Small-fix lane, Advisory spec review, Review before finish, Rebuild cap → `tests/engine/next-step.test.ts` / `tests/engine/gates.test.ts`
- Build entries → `tests/engine/pack-load.test.ts` "default pack build entries validate"

**unit-evidence**
- Red at pre … Restart after an amendment (existing, except "One started unit at a time") → existing `tests/tools/unit-start.test.ts`
- One started unit at a time (adjusted), Started in a lane → `tests/tools/unit-start.test.ts`
- Green at post … Digest changed since start (existing) → existing `tests/tools/unit-finish.test.ts`
- Unresolved blocking finding, Review required but not run, Lane review accepted after merge, Incomplete review does not count, Receipted unit with a new blocking finding → `tests/tools/unit-finish.test.ts`

**Issue #7 "Done when"**
- Five units with lanes, context threshold, inline completion → `tests/e2e/subagent-build.test.ts`
