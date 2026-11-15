# Gates, Questions and Decision Points Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Only a human answer from an approver adapter opens a human gate, and code (not the agent) decides and records each unit's `Difficulty` and `Tags`. Around that, add the unit lock, amendments, Questions with cascade, and stuck reports.

**Architecture:**
- **Pure core.** These pure modules derive every fact from the issue body and own marked comments, so `nextStep` stays pure and every rule is unit-testable:
  - `src/decide/` (rules, records);
  - `src/engine/locks.ts`, `iterations.ts` and `gates.ts`;
  - `src/interaction/commands.ts` and `requests.ts`.
- **Thin I/O shells:**
  - the adapters (`in-session.ts`, `forge.ts`);
  - the completion engine (`complete.ts`);
  - polling;
  - five tools.
- **Request lifecycle.** Each human decision runs one lifecycle: `request` → `answer` (validated once) → idempotent effects → a result comment written last (design D2).

**Tech Stack:** TypeScript (ESM, `.ts` imports, `strict`), `yaml` (only runtime dependency), the `git` executable, vitest, bun, pi `ExtensionAPI` (`ctx.ui.select/confirm/input`, `ctx.hasUI`).

**Spec:** `openspec/changes/gates-and-decisions/specs/` (5 new and 4 modified capabilities) and `openspec/changes/gates-and-decisions/design.md` (decisions D1–D13, D9a). The approved scope and user decisions are in `brainstorm.md`.

## Global Constraints

- `dependencies` stays exactly `{ "yaml": ... }`; no new runtime or dev dependency.
- Use `bun` only: `bun run test`, `bun run typecheck`. CI runs exactly these two.
- All code, comments, docs and commit messages are in English.
- Tests make no network call; the forge is `MemoryWorld` (`tests/forge/memory-forge.ts`), git upstreams are local bare repos (`tests/tools/helpers.ts` `toolHarness`), `$HOME` is injected.
- Never push, never edit pi settings files.
- No tool exposes a parameter for an outcome, choice, answer, `Difficulty` or `Tags` (except `extra_tags`, which only adds).
- Only own marked comments are state (`filterMarked`); forge command comments are plain human input, accepted only through `getPermission(author) ∈ {write, admin}`.
- `rpiv-ask-user-question` and Plannotator are never used.
- A livespec hook or poll never throws into pi; errors go to `session.record`.
- Forge and human text shown to the model is wrapped with `untrusted()` from `src/hooks/phase-card.ts`.
- Body edits keep every other line byte-identical, line endings included (`src/core/lines.ts`).
- Each scenario test is named exactly after its `#### Scenario:` title.
- Coding standards: `~/.agents/skills/coding-standards/SKILL.md`. One responsibility per module. Completion handlers are one function per subject kind, never one god function, and tools stay thin over pure planners.

## Review Focus

1. **The agent writes an approval.** A tool call with extra params such as `{ outcome: "approved" }` must be ignored, and a cancelled dialog must never read as approval. Test in Task 7: `extra outcome parameter is ignored`.
2. **CRLF issue bodies.** Rewriting a question answer, unticking units, replacing a unit block and changing `Tags` must keep `\r\n` endings and every other line. Tests in Task 3: `unit block replace keeps CRLF endings` and `answer line rewrite keeps CRLF endings`.
3. **Command comments with odd shapes.** A command on a later line, `/livespec` in the middle of a line, a Windows newline, a quoted reply (`> /livespec approve`), an edited comment and an extra space must be parsed or ignored deterministically (only a first line starting with `/livespec ` counts), never thrown. Test in Task 2: `quoted, indented or later-line commands are ignored`.
4. **Many concurrent requests.** A pending stuck report plus a pending async question plus a forge `approve` must route to the right request or be ignored as ambiguous, never applied to the wrong subject. Test in Task 6: `approve with a pending stuck and an async question is ambiguous only between gate-like requests`.
5. **The forge fails mid-completion.** Every effect step can throw. A retry must finish the work without a second `stale` comment, a second iteration count or a second advance. Test in Task 6: `completion resumes after each failing step`, parametrized over the steps.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `AdapterName` | new | `"in-session" \| "forge"` in `src/interaction/approver.ts` | yes |
| `RequestKind` | new | `"gate" \| "question" \| "stuck"` | yes |
| `Subject` | new | string: `gate:<phase\|name>` \| `amend:<n>` \| `question:Q<n>` \| `stuck:S<n>` \| `decide:<point>.<subject>` | yes |
| `ApprovalRequest` | new | `{ id: string; kind: RequestKind; subject: Subject; record: RequestRecord; change: number; phase: string; summary: string; links: string[]; files: string[]; options?: { id: string; label: string }[]; mode: "blocking" \| "async"; overridable?: { units: string[] }; question?: { id: string; class: "blocking" \| "non-blocking"; requirements: string[] } }` | yes |
| `Outcome` | new | `"approved" \| "approved_with_notes" \| "changes_requested" \| "dismissed"` | yes |
| `Override` | new | `{ unit: string; difficulty?: "low" \| "medium" \| "high"; tags?: string[] }` | yes |
| `Answered` | new | `{ status: "answered"; outcome: Outcome; choice?: string; notes: string; answer?: string; by: string; at: string; adapter: AdapterName; changesRequirement?: string; questionClass?: "blocking" \| "non-blocking"; overrides?: Override[]; answerComment?: { id: string; author: string; updatedAt: string } }`. For questions, `answer` holds the answer text; an answered question has outcome `approved`, and a dismissed one `dismissed` | yes |
| `RequestRecord` | new | `{ id: string; kind: RequestKind; subject: Subject; mode: "blocking" \| "async"; options?: { id: string; label: string }[]; head_sha: string; gate_digest?: string; snapshot: GateSnapshot \| AmendSnapshot \| QuestionSnapshot \| StuckSnapshot \| DecideSnapshot; summary: string }`. The snapshots are: `GateSnapshot = { target: string; digests: Record<string, string>; failingWaivable: string[] }`; `AmendSnapshot = { action: "edit" \| "add" \| "drop"; unit: string; oldDigest?: string; oldDone?: boolean; lines?: string[]; records: DecisionRecord[] }`; `QuestionSnapshot = { id: string; text: string; requirements: string[] }`; `StuckSnapshot = { id: string }`; `DecideSnapshot = { point: string; subject: string; facts: unknown }`. The caller builds it with `prepareRequest(…)` before any adapter runs. Forge persists it as the `request` comment, and both adapters' answers carry it into the `answer` comment | yes |
| `prepareRequest` | new | `prepareRequest(input: { kind; subject; mode; options?; head: string; body: string; snapshot; summary; now: Date }): RequestRecord` in `src/interaction/requests.ts`. It sets `id` with `newRequestId`, and `gate_digest = gateDigest(body)` for gates | yes |
| `Pending` / `Deferred` | new | `{ status: "pending"; requestId: string }`; `{ status: "deferred"; questionClass: "non-blocking" }`. In-session returns `Deferred` when the human chooses "answer later" | yes |
| `Approver` | new | `interface Approver { readonly name: AdapterName; available(): boolean; request(r: ApprovalRequest): Promise<Answered \| Pending \| Deferred>; poll(requestId: string): Promise<Answered \| { status: "pending" }> }`. The in-session `poll` always returns `pending`; the forge `poll` reads the issue | yes |
| `ApproverUI` | new | `{ hasUI: boolean; select(title: string, options: string[]): Promise<string \| undefined>; confirm(title: string, message: string): Promise<boolean>; input(title: string, placeholder?: string): Promise<string \| undefined> }`, the subset of `ctx.ui` plus `ctx.hasUI` | no |
| `runChain` | new | `runChain(chain: AdapterName[], adapters: Partial<Record<AdapterName, Approver>>, r: ApprovalRequest, hooks: { onDeferred(): Promise<void> }): Promise<Answered \| Pending \| { status: "deferred-all" } \| { status: "refused"; message: string }>` in `src/interaction/chain.ts`. It skips unavailable adapters. On `Deferred` it awaits `hooks.onDeferred()` once (the caller rewrites the question line to `(non-blocking)` with `reclassifyQuestion`), sets the request mode to `async`, and moves on to the next adapter. `deferred-all` means no adapter remained | yes |
| `Command` | new | `{ verb: "approve"; notes: string } \| { verb: "changes"; notes: string } \| { verb: "dismiss"; notes: string } \| { verb: "choose"; option: string; notes: string } \| { verb: "answer"; question: string; text: string; changes?: string; class?: "blocking" \| "non-blocking" } \| { verb: "class"; question: string; class: "blocking" \| "non-blocking" } \| { verb: "set"; unit: string; field: "difficulty"; value: "low" \| "medium" \| "high" } \| { verb: "set"; unit: string; field: "tags"; value: string[] }` | yes |
| `parseCommand` | new | `parseCommand(body: string): Command \| { error: string } \| undefined` in `src/interaction/commands.ts`. It reads only the comment's first line (a trailing `\r` is stripped) and returns `undefined` when that line does not start with `/livespec ` | yes |
| Marker kind `request` | new | id `<subject-token>.<base36 ms>` (e.g. `gate-plan.lx3k2a`); yaml `{ kind; subject; mode; options?; head_sha; gate_digest?; snapshot: unknown; summary }`; plain-text instructions after the yaml block | yes |
| Marker kind `answer` | new | id = request id; yaml `{ request: RequestRecord; answer: Answered; verdict: "valid" \| "superseded"; reason?: string }`, where `RequestRecord` is the `request` yaml (in-session answers have no `request` comment) | yes |
| Marker `gate` data | new use of a core kind | id `<phase\|gate>.<request id \| "self-" + base36 ms>`; yaml `{ request?; phase?; gate?; outcome; choice?; notes; by; at; adapter: AdapterName \| "livespec"; head_sha; waivers: string[]; answer_comment?; superseded?: true; locked?: Record<string, string>; agent_skills?: string }` | yes |
| Marker `amendment` data | new use | id = request id; yaml `{ request; action: "edit" \| "add" \| "drop"; unit; old?: string; new?: string; outcome; by; at; adapter; superseded?: true }` | yes |
| Marker `stale` data | new use | id `<request id>` or `Q<n>`; yaml `{ reason: string; phases: string[]; units: string[]; after_plan: boolean }` | yes |
| Marker `question` data | new use | id `Q<n>.<request id>`; yaml `{ request; class; answer; changes_requirement?; by; at; adapter; answer_comment?; superseded?: true }` | yes |
| Marker `stuck` data | new use | report id `S<n>`: `{ where; tried: { text; link? }[]; hypothesis; options: { id; label }[]; recommended }`; answer id `S<n>-answer`: `{ request; choice; notes; by; at; adapter }` | yes |
| Marker `decision` data | new use | id `<point>.<subject>`; yaml `DecisionRecord = { point; subject; digest?; source: "rule" \| "human"; outcome: unknown; facts?: unknown; facts_hash?: string; reason: string; agent_additions?: string[]; overridden_by?: { by: string; at: string; from: unknown }; request?: string }` | yes |
| `RuleResult` | new | `{ outcome: unknown; reason: string; data?: { agentAdditions?: string[] } } \| { ask: { summary: string; options: { id: string; label: string }[] } }` | yes |
| `RuleSchema` | new | `{ validate(node: yaml.Node \| null, report: (n: yaml.Node, msg: string) => void): void; merge?(base: unknown, over: unknown): unknown }` | yes |
| `registerRule` | new | `registerRule(point: string, schema: RuleSchema, fn: (facts: unknown, config: unknown) => RuleResult): void`; `ruleFor(point)`; `resetRulesForTests()`; `registerBuiltinRules()` in `src/decide/registry.ts` | yes |
| `decide` | new | `decide(point: string, facts: unknown, deps: { config: unknown; subject: string; ask?: (intent: DecisionAsk) => Promise<Answered \| Pending> }): Promise<{ status: "decided"; outcome: unknown; source: "rule" \| "human"; reason: string; facts: unknown; data?: { agentAdditions?: string[] } } \| Pending>`. Throws on an unregistered point | yes |
| `DecisionAsk` | new | `{ point: string; subject: string; facts: unknown; summary: string; options: { id: string; label: string }[] }` in `src/decide/seam.ts`. The caller (application boundary) turns it into an `ApprovalRequest` with `prepareRequest` and runs the chain, so Task 1 does not depend on Task 4 | yes |
| `TagsConfig` | new | `{ mode: "rule"; paths: Record<string, string[]>; keywords: Record<string, string[]> }` | yes |
| `tags` facts | new | `{ title: string; covers: string[]; files: string[]; doneMeans: string[]; extraTags: string[] }` → outcome `string[]`, `data.agentAdditions` | yes |
| `difficulty` facts | new | `{ tags: string[]; covers: string[]; files: string[] }` → outcome `"low" \| "medium" \| "high"` | yes |
| `formatDecisionBlock` / `parseDecisionBlocks` | new | `formatDecisionBlock(point: string, record: DecisionRecord): string`; `parseDecisionBlocks(body: string): DecisionRecord[]` in `src/decide/records.ts` | yes |
| `decisionComment` / `latestDecisions` | new | `decisionComment(r: DecisionRecord): string`, which hashes facts whose yaml exceeds 2,000 characters; `latestDecisions(marked: MarkedComment[]): Map<string, DecisionRecord>` | yes |
| Pack `decisions` | modified | `decisions: { tags: TagsConfig; difficulty: { mode: "rule" } }` in `src/packs/agent-skills.yaml`; `plan.checks` gains `unit-classification` (Task 4) | yes |
| `interaction.adapter` config | new | `ProjectConfig.interaction?: { adapter: AdapterName[] }`, `UserConfig.interaction?: { adapter: AdapterName[] }`; `adapterChain(config: LoadedConfig): { chain: AdapterName[]; source: "project" \| "user" \| "default" }` in `src/config.ts` | yes |
| `UnitInput` | new | `{ title: string; covers: string[]; files: string[]; done_means: { label: string; text: string }[]; scenarios: { label: string; ref: string }[]; depends: string[]; verify: string; kind?: "refactor"; extra_tags?: string[] }` | yes |
| Unit block helpers | new | in `src/core/unit-blocks.ts`: `renderUnit(u: UnitInput & { id: string; difficulty: string; tags: string[] }): string[]`; `replaceUnitBlock(body: string, id: string, lines: string[]): string`; `insertUnitBlock(body: string, lines: string[]): string`; `removeUnitBlock(body: string, id: string): string`; `setUnitField(body: string, id: string, field: "Difficulty" \| "Tags", value: string): string` | yes |
| Question line helpers | new | in `src/core/question-lines.ts`: `appendQuestion(body: string, cls: "blocking" \| "non-blocking", text: string): { body: string; id: string }`; `answerQuestion(body: string, id: string, cls: "blocking" \| "non-blocking", answer: string): string`; `reclassifyQuestion(body: string, id: string, cls: "blocking" \| "non-blocking"): string` | yes |
| `registerCheck` | modified | `registerCheck(name: string, fn: CheckFn, opts?: { waivable?: boolean }): void`; `isWaivable(name: string): boolean` | yes |
| `CheckContext` | modified | adds `marked: MarkedComment[]`; `runChecks(pack, state, ctx)` passes `state.marked` | yes |
| `registerGate` / `registerGatePayload` | new | `registerGate(name: string, g: { checks: string[]; options?: { id: string; label: string }[] }): void`; `registerGatePayload(phase: string, fn: (s: ChangeState, facts: ReviewFacts) => string \| undefined): void` in `src/engine/gates.ts` | yes |
| `gateRefusal` | new | `gateRefusal(state: ChangeState, pack: Pack, target: string, ignoreRequest?: string): string \| undefined` (pure) | yes |
| `ReviewFacts` / `gatePayload` | new | `ReviewFacts = { specsStat: string; specsFiles: string[]; issueUrl?: string }`; `collectReviewFacts(git: Pick<Git, "diffStat" \| "diffNames">, base: string \| undefined): Promise<ReviewFacts>` in `src/engine/gate-payload.ts` (the only I/O; `gates.ts` stays pure); `gatePayload(state: ChangeState, pack: Pack, target: string, facts: ReviewFacts): { summary: string; links: string[]; files: string[] }` (pure) | yes |
| `RequestsState` | new | `{ pending: PendingRequest[]; applying: AppliedAnswer[] }`, where `PendingRequest = { id; subject; kind; mode; createdAt; data }` and `AppliedAnswer = { id; subject; record: AnswerData }`; `readRequests(marked: MarkedComment[]): RequestsState` in `src/interaction/requests.ts` | yes |
| `LockState` | new | `{ locked: Record<string, string> \| undefined; frozen: string[]; staleUnits: string[]; stalePhases: string[]; gates: Record<string, GateResult \| undefined> }`, where `GateResult = { outcome: Outcome; superseded: boolean; at: string; waivers: string[]; notes: string }` is the valid gate result per phase (`waivers` added during apply, Task 7: nextStep skips failing checks the phase's valid approved gate waived, so a waived gate advances — additive, internal consumers only; `notes` added in the final-review fix wave: the next step of a `changes_requested` or `dismissed` result shows the human's notes — additive, internal consumers only); `deriveLocks(change: Change, marked: MarkedComment[]): LockState` and `gateDigest(body: string): string` in `src/engine/locks.ts` | yes |
| `IterationState` | new | `{ count: number; cap: number \| undefined; blocking: boolean; stuckOpen: string \| undefined }`; `deriveIterations(marked: MarkedComment[], cap?: number): IterationState` in `src/engine/iterations.ts` | yes |
| `ChangeState` | modified | adds `marked: MarkedComment[]; requests: RequestsState; lock: LockState; iterations: IterationState; commandWarnings: string[]`; `counters.change_iterations` is set from `iterations.count` | yes |
| `NextStep` | modified | adds `pending: { id: string; subject: string; mode: string; adapter: AdapterName }[]; frozenUnits: string[]; staleUnits: string[]; stuckOpen?: string` | yes |
| `Git` | modified | adds `diffStat(from: string, to: string, path: string): Promise<string>` (`git diff --stat`) and `diffNames(from: string, to: string, path: string): Promise<string[]>` (`git diff --name-only`), both in Task 4; adds `merge(ref: string): Promise<"ok" \| "conflict">; mergeAbort(): Promise<void>; isAncestor(a: string, b: string): Promise<boolean>` in Task 8 | yes |
| `DoctorDeps` | modified | adds `config: LoadedConfig; hasUI: boolean` | no |
| `pollApprovals` | new | `pollApprovals(session: Session): Promise<void>` in `src/interaction/poll.ts`; never throws; stores warnings in `session.commandWarnings` | yes |
| `registerLivespecTool` | new | `registerLivespecTool(pi: ExtensionAPI, def: ToolDefinition): void` in `src/tools/register.ts`. It wraps `execute` so `pollApprovals(getSession())` runs first; every livespec tool registers through it | no |
| `approverFor` | new | `approverFor(session: Session, ctx: { hasUI: boolean; ui: ApproverUI-like }, issue: number): { chain: AdapterName[]; adapters: Partial<Record<AdapterName, Approver>> }` in `src/tools/approver-for.ts` | no |
| Tool `spec_gate` | new | params `{ target: string }` | yes |
| Tool `plan_units` | new | params `{ units: UnitInput[] }` | yes |
| Tool `unit_amend` | new | params `{ unit?: string; add?: boolean; drop?: boolean; replacement?: UnitInput }`, in exactly one of three forms: `{ unit, replacement }`, `{ add: true, replacement }` or `{ drop: true, unit }` | yes |
| Tool `spec_question` | new | params `{ text?: string; class?: "blocking" \| "non-blocking"; reask?: string }` | yes |
| Tool `spec_stuck` | new | params `{ where: string; tried: { text: string; link?: string }[]; hypothesis: string; options: { id: string; label: string }[]; recommended: string }` | yes |

**Spec contract note.** `Approver.poll` is kept, as the approver-adapters spec requires. `pollApprovals` is the session-level loop that calls the forge adapter's matching logic and also finishes applying requests.

---

## Task 1: Decision seam, rules and pack decisions — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4, 1.5
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Create: `src/decide/registry.ts`, `src/decide/seam.ts`, `src/decide/records.ts`, `src/decide/rules/tags.ts`, `src/decide/rules/difficulty.ts`, `src/decide/builtin.ts` (calls `registerBuiltinRules()` as a side effect)
- Modify: `src/engine/pack-load.ts` (`import "../decide/builtin.ts"`), `src/engine/pack-merge.ts` (merge `decisions` per point), `src/packs/agent-skills.yaml` (`decisions` only), `tests/fixtures/agent-skills.pack.json` (`decisions` only), `tests/engine/pack-load.test.ts`, `tests/engine/checks.test.ts`, `tests/content/compat.test.ts`
- Test: `tests/decide/registry.test.ts`, `tests/decide/tags.test.ts`, `tests/decide/difficulty.test.ts`, `tests/decide/seam.test.ts`, `tests/decide/records.test.ts`

**Interfaces:**
- Consumes: `registerPackSchema("decisions", …)`, `matchGlob` (`src/core/glob.ts`), `writeMarked` and `MarkedComment` (`src/forge/markers.ts`).
- Produces: `registerRule`, `ruleFor`, `registerBuiltinRules`, `resetRulesForTests`, `decide`, `RuleResult`, `RuleSchema`, `TagsConfig`, `DecisionRecord`, `decisionComment`, `latestDecisions`, `formatDecisionBlock`, `parseDecisionBlocks`, and `mergeDecisions(base, over)`.

- [ ] **Step 1:** Write `tests/decide/registry.test.ts`:
  - the scenarios `Jev rejected` and `Unknown point`;
  - `missing mode is an error`;
  - `tags config with a non-list glob is an error`;
  - `registerBuiltinRules re-registers after a reset`.

  Each error assertion checks `{ file, line, col }` from `validatePackDocument`.
- [ ] **Step 2:** Run `bun run test tests/decide/registry.test.ts`; expect FAIL because the module is missing.
- [ ] **Step 3:** Implement `src/decide/registry.ts`. It keeps a module-level `Map<point, { schema, fn }>` and registers one `decisions` `SubSchema` on every `registerRule` call. The exact messages are:
  - for `mode: jev`: "`jev` is reserved for a later version; use `mode: rule`";
  - for a missing or other mode: "`mode` must be `rule`";
  - for an unknown key: "no rule is registered for decision point `<key>`".

  `mergeDecisions` applies the per-point `schema.merge`, or a one-level spread when the point has none.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Write `tests/decide/tags.test.ts`:
  - the scenarios `Path match`, `Keyword whole word`, `Keyword phrase ignoring case`, and `Override adds globs` (a unit test of `merge`);
  - `extra tags are appended once and reported as agent additions`;
  - `tags follow config order`;
  - `extra tag that is not kebab-case is refused`.
- [ ] **Step 6:** Run; expect FAIL.
- [ ] **Step 7:** Implement `src/decide/rules/tags.ts`. A keyword matches with `new RegExp("(^|[^a-z0-9])" + escaped.replace(/ /g, "\\s+") + "($|[^a-z0-9])", "i")` over `[title, ...covers, ...doneMeans].join("\n")`. `data.agentAdditions` lists the extra tags the rule did not produce. The merge is a per-tag union that keeps order and drops duplicates.
- [ ] **Step 8:** Run; expect PASS.
- [ ] **Step 9:** Write `tests/decide/difficulty.test.ts`:
  - the scenarios `Two capabilities` and `Medium default`;
  - `security tag is high`;
  - `five files is high`;
  - `one file without tags is low`;
  - `one file with a tag is medium`.

  The capability is the part of a `Covers` entry before `/`. Run; FAIL. Implement. Run; PASS.
- [ ] **Step 10:** Write the remaining tests:
  - `tests/decide/seam.test.ts`: `Rule outcome`, `Rule asks` (a fake `ask` receives the exact `DecisionAsk` intent and returns `choice: "y"`), `pending ask returns the request id`, `rule data is passed through`, `unregistered point throws`;
  - `tests/decide/records.test.ts`: `Record fields`, `Large facts hashed` (2,001 characters of facts yaml gives `facts_hash`, the sha256 hex of the yaml, and no `facts`), `Round trip in a PR body`, `latest record per id wins`.
- [ ] **Step 11:** Run; FAIL. Implement `seam.ts` and `records.ts`. `decide` never writes anything. Run; PASS.
- [ ] **Step 12:** Set `decisions:` in `src/packs/agent-skills.yaml` to the `tags` map from issue #5, verbatim, with `mode: rule`, plus `difficulty: { mode: rule }`. Transcribe the same into the fixture.
  - Add `import "../decide/builtin.ts"` to `pack-load.ts`, next to `import "./checks.ts"`.
  - In `mergePack`, call `mergeDecisions` for `decisions`.
  - Every test file that calls `resetRegistryForTests()` and then loads a pack must call `registerBuiltinRules()` right after the reset: `tests/engine/pack-load.test.ts`, `tests/engine/checks.test.ts` and `tests/content/compat.test.ts`. `tests/engine/pack-schema.test.ts` and `tests/engine/registry.test.ts` keep an empty registry. The reset itself does not re-register.
  - Add the scenario `Decisions merge through the rule` to `pack-load.test.ts`.
  - Assert `decisions.difficulty.mode === "rule"` in `Spot check`.
- [ ] **Step 13:** Run `bun run test tests/engine tests/decide` and `bun run typecheck`; expect PASS, including `Default pack contents` and the fresh-module test.
- [ ] **Step 14:** Commit `feat(decide): decision seam, tags and difficulty rules, pack decisions`.

---

## Task 2: Approver contract, command parser, config and in-session adapter — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/interaction/approver.ts`, `src/interaction/commands.ts`, `src/interaction/in-session.ts`, `src/interaction/chain.ts`
- Modify: `src/config.ts`
- Test: `tests/interaction/commands.test.ts`, `tests/interaction/in-session.test.ts`, `tests/interaction/chain.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: `registerKind` and `LoadedConfig`.
- Produces:
  - the Contracts types from `AdapterName` to `parseCommand`;
  - `createInSessionApprover(ui: ApproverUI, login: () => Promise<string>): Approver`;
  - `runChain`;
  - `adapterChain`.

- [ ] **Step 1:** Write `tests/interaction/commands.test.ts`. It needs one exact parse per verb, for example `parseCommand("/livespec answer Q2 use per-user limits --changes rate-limit/Requirement: Per-IP cap")` → `{ verb: "answer", question: "Q2", text: "use per-user limits", changes: "rate-limit/Requirement: Per-IP cap" }`. Also cover:
  - `--class` before `--changes`;
  - `set U2 tags a, b` → `["a","b"]`;
  - `changes` without notes → `{ error }`;
  - `choose` without an id → `{ error }`;
  - `CRLF first line is accepted`;
  - Review Focus 3: `quoted, indented or later-line commands are ignored`. `> /livespec approve`, `  /livespec approve`, and `/livespec approve` on line 2 after a blank line all give `undefined`.
- [ ] **Step 2:** Run; FAIL. Implement `parseCommand`. Run; PASS.
- [ ] **Step 3:** Add the tests:
  - `tests/config.test.ts`: the scenarios `Interaction adapter list` and `Unknown adapter name`, plus `interaction adapter must be a list` and `project chain wins over user chain`;
  - `tests/interaction/chain.test.ts`: the scenarios `Default chain` and `No adapter available` (`runChain` refuses with a message naming `interaction.adapter`), plus `first available adapter is used` and `answer later moves on to the next adapter`. In that last test, `[in-session, forge]` with in-session `deferred` calls `onDeferred` once and gives the forge `request` with mode `async`. Also add `answer later with no further adapter returns deferred-all`.
- [ ] **Step 4:** Run; FAIL. Implement the config keys (`interaction` in the project and user key lists), `adapterChain` and `runChain`. Run; PASS.
- [ ] **Step 5:** Write `tests/interaction/in-session.test.ts` with a scripted fake `ApproverUI`:
  - `Approve in the TUI`;
  - `cancelled select is dismissed`;
  - `changes asks for notes`;
  - `waive option is offered when given`;
  - `question answer goes into answer, and the requirement choice into changesRequirement` (options `no`, each requirement, `other`);
  - `answer later returns deferred`;
  - `override prompts set difficulty and tags`;
  - `unavailable without UI`;
  - `poll is always pending`.
- [ ] **Step 6:** Run; FAIL. Implement `createInSessionApprover` following design D5. `by` is `await login()`. Run; PASS.
- [ ] **Step 7:** Run `bun run typecheck`. Commit `feat(interaction): approver contract, command parser, in-session adapter`.

---

## Task 3: Byte-preserving body helpers — implements 3

**Covers:** 3.1, 3.2
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/core/unit-blocks.ts`, `src/core/question-lines.ts`
- Test: `tests/core/unit-blocks.test.ts`, `tests/core/question-lines.test.ts`

**Interfaces:**
- Consumes: `splitLines`, `joinLines`, `parseChange`, `UnitInput` (declared here as the Contracts row; `src/tools/plan-units.ts` imports it later).
- Produces: the unit block helpers and the question line helpers listed in Contracts.

- [ ] **Step 1:** Write `tests/core/unit-blocks.test.ts` over `tests/fixtures/change-body.md`:
  - `rendered unit parses back with the same fields`, where the field order follows the fixture: `Covers`, `Difficulty`, `Tags`, `Files`, `Done means`, `Scenarios`, `Depends` (`—` when empty), `Verify` in backticks, optional `Kind`, then `- [ ] pending`;
  - `replace keeps every other line byte-identical`;
  - Review Focus 2: `unit block replace keeps CRLF endings`;
  - `insert appends after the last unit`;
  - `remove keeps other blocks`;
  - `setUnitField changes one line`.
- [ ] **Step 2:** Run; FAIL. Implement. Run; PASS.
- [ ] **Step 3:** Write `tests/core/question-lines.test.ts`:
  - the scenario `Answer written back`;
  - Review Focus 2: `answer line rewrite keeps CRLF endings`;
  - `append numbers after the highest Q`;
  - `append creates the Questions section in canonical order`;
  - `multi-line text is refused`;
  - `reclassify changes only the class`.
- [ ] **Step 4:** Run; FAIL. Implement. The answer separator is ` — Answer: `, as `parseChange` reads it. Run; PASS.
- [ ] **Step 5:** Run `bun run typecheck`. Commit `feat(core): byte-preserving unit block and question line helpers`.

---

## Task 4: Change-state facts, classification check and gate evaluation — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
**Difficulty:** Hard
**Blocked by:** Task 1, Task 2

**Files:**
- Create: `src/interaction/requests.ts`, `src/engine/locks.ts`, `src/engine/iterations.ts`, `src/engine/unit-classification.ts`, `src/engine/gates.ts`, `src/engine/gate-payload.ts`
- Modify:
  - `src/engine/state-types.ts`, `src/engine/snapshot.ts`, `src/engine/counters.ts`, `src/engine/registry.ts` (`waivable`, `CheckContext.marked`) and `src/engine/checks.ts` (register `unit-classification`, pass `marked`);
  - `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json` (`plan.checks` gains `unit-classification`);
  - `tests/engine/pack-load.test.ts` (stub `unit-classification` in `beforeEach`);
  - `src/engine/git.ts` (`diffStat`, `diffNames`), with tests in `tests/engine/git.test.ts`;
  - every test builder of `ChangeState`, namely `tests/helpers/change-state.ts` `stateFor` (the shared one) and any inline builders in `tests/engine/next-step.test.ts`, `tests/hooks/phase-card.test.ts` and `tests/hooks/helpers.ts`, which get the new fields with empty defaults.
- Test: `tests/interaction/requests.test.ts`, `tests/engine/locks.test.ts`, `tests/engine/iterations.test.ts`, `tests/engine/snapshot.test.ts`, `tests/engine/checks.test.ts`, `tests/engine/counters.test.ts`, `tests/engine/registry.test.ts`, `tests/engine/gates.test.ts`

**Interfaces:**
- Consumes: `unitDigest`, `parseChange`, `filterMarked`, `latestDecisions` (Task 1), the marker kinds `request` and `answer` (Task 2), and `Git.diff`.
- Produces:
  - `readRequests`, `prepareRequest`;
  - `requestComment(id, data, plainText)`, `answerComment(id, data)` and `newRequestId(subject, now)`;
  - `deriveLocks`, `gateDigest` and `deriveIterations`;
  - `isWaivable`;
  - the `unit-classification` check;
  - the extended `ChangeState`;
  - `registerGate`, `gateRefusal`, `registerGatePayload`, `collectReviewFacts` and `gatePayload`.

- [ ] **Step 1:** Write `tests/interaction/requests.test.ts`:
  - `request without answer is pending`;
  - `answer without result is applying`;
  - `result with request id completes it`;
  - `in-session answer without request is applying`;
  - `request id matches the marker id pattern`.

  Run; FAIL. Implement. Run; PASS.
- [ ] **Step 2:** Write `tests/engine/locks.test.ts`, building a change from `tests/fixtures/change-body.md` plus marked comments:
  - the scenarios `Web edit freezes a unit`, `Tick does not freeze` and `Second plan gate re-locks`;
  - `amendment add and drop update the lock`;
  - `stale unit cleared by a later approved amendment`;
  - `valid gate result ignores results older than a stale listing the phase`;
  - `superseded latest result gives no valid result`;
  - `gateDigest ignores Questions and status lines`.

  Run; FAIL. Implement per design D8 and D2. Run; PASS.
- [ ] **Step 3:** Write `tests/engine/iterations.test.ts`:
  - `Derived iteration count`;
  - `cap blocks without a later stuck answer`;
  - `stuck answer after the last counted cascade lifts the block`;
  - `a new counted cascade blocks again`;
  - `open stuck report is reported`.

  Run; FAIL. Implement. Run; PASS.
- [ ] **Step 4:** Extend `ChangeState` with `marked`, `requests`, `lock`, `iterations` and `commandWarnings`. Make `readCommentFacts` keep the own marked comments and derive the rest. Set `counters.change_iterations` from `iterations.count`. Update every `ChangeState` test builder with empty defaults. Add these tests:
  - in `tests/engine/snapshot.test.ts`, the scenario `Pending request and lock from comments` and `iterations count overrides the counter value`;
  - in `tests/engine/counters.test.ts`, `change_iterations counter comment is ignored`.

  Run `bun run test tests/engine tests/hooks tests/tools` and `bun run typecheck`; PASS.
- [ ] **Step 5:** Add `opts.waivable` to `registerCheck`, `isWaivable`, and `CheckContext.marked`, with `runChecks` passing `state.marked`. Add the tests:
  - in `tests/engine/registry.test.ts`, `waivable flag is stored`;
  - in `tests/engine/checks.test.ts`, the scenario `Tag removed in the body`, plus `unit without a record is an error` and `record for a digest not in the body is ignored`.

  Run; FAIL. Implement the `unit-classification` check and register it in `BUILTIN_CHECKS`. Add it to `plan.checks` in the pack and the fixture, and to the stub list in `pack-load.test.ts`. Run; PASS.
- [ ] **Step 6:** Write `tests/engine/gates.test.ts`:
  - the scenarios `Blocking question keeps the gate closed`, `Failing check that is not waivable`, `Plan gate with a stale unit`, `Plan payload` and `Define payload`;
  - `Cap reached`, for the gate-refusal part;
  - `named gate is accepted outside its phase`;
  - `dirty tree refuses`;
  - `gate none refuses`;
  - `the ignored request does not refuse`, with `ignoreRequest` set;
  - `registered payload is appended`.
- [ ] **Step 7:** Add `diffStat diffNames over specs` to `tests/engine/git.test.ts`. Run; FAIL. Implement `Git.diffStat` and `Git.diffNames`, then `gates.ts` (pure) and `gate-payload.ts`. In `gate-payload.ts`, `collectReviewFacts` calls the two git methods and is the only I/O. Run; PASS.
- [ ] **Step 8:** Run `bun run test` and `bun run typecheck`; PASS. Commit `feat(engine): approval facts, unit lock, iterations, classification check and gate evaluation`.

---

## Task 5: Next step and phase card — implements 5

**Covers:** 5.1, 5.2, 5.3
**Difficulty:** Normal
**Blocked by:** Task 4

**Files:**
- Modify: `src/engine/next-step.ts`, `src/engine/state-types.ts` (`NextStep` fields), `src/tools/format-step.ts`
- Create: `src/interaction/card.ts`, which registers the `approvals` card section, imported from `src/extension.ts`
- Test: `tests/engine/next-step.test.ts`, `tests/hooks/phase-card.test.ts`

**Interfaces:**
- Consumes: the `ChangeState` additions (Task 4), `successorOf`, `registerCardSection` and `untrusted`.
- Produces: the `NextStep` fields `pending`, `frozenUnits`, `staleUnits` and `stuckOpen`, and an `advance` derived from the valid gate result.

- [ ] **Step 1:** Add to `tests/engine/next-step.test.ts`:
  - the scenarios `Pending gate request`, `Stuck report first`, `Frozen unit`, `Dismissed gate` and `Ship approved`;
  - the existing `Human gate ready` and `Blocking question first`, unchanged;
  - `approved define gate reports advance to plan`;
  - `changes requested asks to revise`;
  - `superseded result asks to request again`;
  - `async question request does not block`;
  - `frozen units do not block define`;
  - `cap blocking asks for spec_stuck`;
  - `applying request blocks like a pending one`.

  The sentences must match exactly:
  - "Wait for the human's choice on stuck report S1."
  - "Wait for the human's answer to gate:plan on the forge."
  - "Send a stuck report with spec_stuck: change_iterations reached 5 of 5."
  - "Amend U2 with unit_amend: it changed after the plan was locked."
  - "Amend U3 with unit_amend: it is stale after Q2."
  - "The define gate requested changes: revise, then request the gate again."
  - "The define gate was dismissed: ask the human how to proceed."
  - "The define gate approval no longer matches the change: request the gate again."
  - "The ship gate is approved: the change is ready to ship."
- [ ] **Step 2:** Run; FAIL. Implement the new rules in the design D13 order, each as its own `Rule`. `gate()` reads `state.lock.gates[phase]`. Run; PASS.
- [ ] **Step 3:** Add the scenarios `Pending approvals shown` and `Ignored command shown` to `tests/hooks/phase-card.test.ts`, and keep `Card contents`, `Stale card` and `Registered section` passing. Implement `src/interaction/card.ts`.
- [ ] **Step 4:** Run `bun run test` and `bun run typecheck`; PASS. Commit `feat(engine): next step and card for approvals, locks and stuck reports`.

---

## Task 6: Completion engine, forge adapter, polling and doctor — implements 6

**Covers:** 6.1, 6.2, 6.3, 6.4, 6.5
**Difficulty:** Very Hard
**Blocked by:** Task 3, Task 4, Task 5 (the phase moves asserted by `Forge approval completes` and `Answer picked up at session start` come from `nextStep.advance`, and both tasks edit `src/extension.ts`)

**Files:**
- Create:
  - `src/interaction/complete.ts`, the dispatcher with `validateAnswer`, `recordAnswer` and `applyAnswer`;
  - `src/interaction/complete-gate.ts`, `complete-amend.ts`, `complete-question.ts`, `complete-stuck.ts` and `complete-decide.ts`;
  - `src/interaction/forge.ts`, `src/interaction/poll.ts`, `src/interaction/doctor.ts`;
  - `src/tools/register.ts`, `src/tools/approver-for.ts`.
- Modify:
  - `src/tools/change-tools.ts`, `src/tools/spec-validate.ts`, `src/tools/spec-status.ts`, `src/tools/spec-next.ts`, `src/tools/skill-note.ts`, `src/tools/spec-write.ts`, `src/tools/change-new.ts` and `src/tools/change-start.ts`, which all register through `registerLivespecTool`;
  - `src/hooks/session.ts` (`commandWarnings`, poll after `reconnect` in `startSession`) and `src/hooks/card-input.ts` (copy the warnings into the state);
  - `src/commands/next.ts`, `src/commands/doctor.ts` and `src/commands/deps.ts` (`config` and `hasUI` in `DoctorDeps`);
  - `src/extension.ts` (import the doctor check).
- Test: `tests/interaction/complete.test.ts`, `tests/interaction/forge.test.ts`, `tests/interaction/poll.test.ts`, `tests/interaction/doctor.test.ts`, `tests/tools/register.test.ts`

**Interfaces:**
- Consumes:
  - from Task 4: `readRequests`, `deriveLocks`, `gateDigest`, `gateRefusal`, `requestComment` and `answerComment`;
  - from Task 2: `parseCommand`, `runChain` and `createInSessionApprover`;
  - from Task 3: the unit block and question line helpers;
  - `untickUnit`, `advancePhase`, `unitDigest`, `latestDecisions`, `decisionComment`, `validateUnits`;
  - `Forge.getPermission`, `createComment` and `updateIssueBody`.
- Produces:
  - `completeAnswer(ctx: CompletionCtx, req: RequestRecord, ans: Answered): Promise<{ status: "completed" | "superseded"; result: string }>`, where `CompletionCtx = { forge; git; pack; issue: number; marked: MarkedComment[]; agentSkills?: string; now: () => Date }`;
  - `finishApplying(ctx)`;
  - `createForgeApprover(forge: Forge, issue: number): Approver`. `request(r)` writes `requestComment(r.record.id, r.record, plainText(r))`, so the snapshot comes from the prepared envelope;
  - `matchCommands(pending, comments, perms): { matches; warnings }`;
  - `pollApprovals`, `registerLivespecTool` and `approverFor`;
  - the `approver` doctor check.

- [ ] **Step 1:** Write `tests/interaction/forge.test.ts` over `MemoryWorld`:
  - the scenarios `Pending gate request`, `Duplicate request refused`, `Approve by a writer`, `Command without write access ignored`, `Command before the request ignored` and `Answer that changes a requirement`;
  - Review Focus 4: `approve with a pending stuck and an async question is ambiguous only between gate-like requests`;
  - `approve with failing waivable checks is ignored with a waive hint`;
  - `getPermission is called once per author`;
  - `poll returns the matched answer`;
  - `request comment round-trips the prepared record`.
- [ ] **Step 2:** Run; FAIL. Implement `createForgeApprover`, with the plain-text template of design D4, and the pure `matchCommands`. Run; PASS.
- [ ] **Step 3:** Write `tests/interaction/complete.test.ts`:
  - the scenarios `Plan gate locks digests`, `HEAD moved before the answer`, `Issue edited before the answer`, `Forge approval completes`, `Crash while applying`, `Unit finished while the drop was pending`, `Retried cascade counts once`, `Foreign marked gate ignored` and `Forge answer recorded`;
  - `Override recorded`, `override keeps other lines byte-identical`, `Answer sends the change back` (at completion level) and `Choice recorded`;
  - Review Focus 5: `completion resumes after each failing step`. It is parametrized over each effect throwing once, then calls `finishApplying` and asserts exactly one `stale`, one result comment and one count.
- [ ] **Step 4:** Run; FAIL. Implement the dispatcher and the apply modules in the order validate → `answer` comment → effects (each skipped when already applied) → result comment. Each `complete-*.ts` exports one `apply<Kind>(ctx, record): Promise<string>` and keeps helpers single-purpose. Run; PASS.
- [ ] **Step 5:** Write the tests:
  - `tests/interaction/poll.test.ts`: the scenarios `Answer picked up at session start` (through `registerSessionHooks`, with a session on the change branch) and `Poll failure tolerated`; plus `poll skips without pending or applying requests`, which asserts no fresh `listComments`; `applying requests are finished before new commands`; and `ignored commands become card warnings`;
  - `tests/tools/register.test.ts`: `every livespec tool polls first`, which iterates over the registered tool names, including `spec_validate`.
- [ ] **Step 6:** Run; FAIL. Implement `pollApprovals` and `registerLivespecTool`, and move every existing tool registration onto it. Hook polling into `startSession` after `reconnect`, and into `runNextCommand`. Run; PASS.
- [ ] **Step 7:** Write `tests/interaction/doctor.test.ts` with the scenario `Doctor names the adapter`, plus `doctor errors when no adapter is available`. Add `config` and `hasUI` to `DoctorDeps` and `doctorDeps`, and implement `approverFor` and the check with `registerDoctorCheck("approver", …)`. Run; PASS.
- [ ] **Step 8:** Run `bun run test` and `bun run typecheck`; PASS. Commit `feat(interaction): completion engine, forge adapter, polling and doctor`.

---

## Task 7: Gates tool — implements 7

**Covers:** 7.1, 7.2, 7.3
**Difficulty:** Hard
**Blocked by:** Task 5, Task 6

**Files:**
- Create: `src/tools/spec-gate.ts`
- Modify: `tests/hooks/fake-pi.ts` (`confirm` and `input` in `fakeCtx`; the `tools` map also keeps `parameters`, typed as `unknown`), `tests/tools/helpers.ts` (a `ui` option that is passed to `fakeCtx`), `src/tools/change-tools.ts`
- Test: `tests/tools/spec-gate.test.ts`

**Interfaces:**
- Consumes: `gateRefusal`, `gatePayload`, `collectReviewFacts`, `approverFor`, `runChain`, `completeAnswer`, `registerLivespecTool`, `content.activeTree()` (its basename is the agent-skills commit).
- Produces: the `spec_gate` tool.

- [ ] **Step 1:** Extend `fakeCtx` to take `{ hasUI, select, confirm, input }`, and add `toolHarness({ ui })`. Existing tests stay green.
- [ ] **Step 2:** Write `tests/tools/spec-gate.test.ts`:
  - the scenarios `Relayed approval refused`, `Unavailable without UI`, `No adapter available`, `Self gate`, `Registered gate`, `Waive at the gate`, `Approve without waiving`, `Define approved`, `Old approval not reused after a cascade`, `Superseded result does not fall back`, `Failed move retried`, `Ship approved`, `Changes requested` and `Dismissed`;
  - Review Focus 1: `extra outcome parameter is ignored`.
- [ ] **Step 3:** Run; FAIL. Implement `spec_gate`. `execute(_id, params, _signal, _update, ctx)` passes `ctx` to `approverFor`. A self gate writes through `complete-gate` with `adapter: livespec`. Then call `afterForgeWrite`. Run; PASS.
- [ ] **Step 4:** Run `bun run test` and `bun run typecheck`; PASS. Commit `feat(tools): spec_gate with self, human, named and waivable gates`.

---

## Task 8: Unit planning and amendments — implements 8

**Covers:** 8.1, 8.2, 8.3, 8.4
**Difficulty:** Very Hard
**Blocked by:** Task 7

**Files:**
- Create: `src/tools/classify-units.ts`, `src/tools/plan-units.ts`, `src/tools/plan-units-steps.ts`, `src/tools/unit-amend.ts`
- Modify: `src/engine/git.ts`, `src/tools/change-tools.ts`
- Test: `tests/engine/git.test.ts`, `tests/tools/plan-units.test.ts`, `tests/tools/unit-amend.test.ts`

**Interfaces:**
- Consumes: `decide`, `decisionComment`, `validateUnits`, `checkDoneMapsScenarios`, the unit block helpers, `unitDigest`, `integrationBranch`, `approverFor`, `runChain`, `completeAnswer`, `registerLivespecTool`.
- Produces:
  - `classifyUnits(units: { id: string; input: UnitInput }[], config: Pack["decisions"]): Promise<{ units: (UnitInput & { id: string; difficulty: string; tags: string[] })[]; records: DecisionRecord[] }>` (ids are allocated by the caller: `plan_units` assigns `U1…Un`, `unit_amend` keeps the edited id or takes the next free id for `--add`);
  - the `plan_units` and `unit_amend` tools.

- [ ] **Step 1:** Add to `tests/engine/git.test.ts`: `merge reports conflict and mergeAbort restores the tree`, and `isAncestor`. Run; FAIL. Implement:
  - `merge`: `git merge --no-edit --no-ff -- <ref>`, where exit 1 with unmerged paths is `"conflict"`;
  - `isAncestor`: `merge-base --is-ancestor`, where exit 0 is true and exit 1 is false.

  Run; PASS.
- [ ] **Step 2:** Write `tests/tools/plan-units.test.ts`:
  - the scenarios `Units written with classification`, `Base is an ancestor of HEAD`, `Unknown outcome with an unchanged base`, `Write conflict keeps the base consistent`, `Change start still reconciles`, `Merge conflict`, `Invalid unit`, `Locked plan` and `Agent cannot remove a tag`;
  - `refuses outside plan`;
  - `refuses on a dirty tree`.
- [ ] **Step 3:** Run; FAIL. Implement `plan_units` following the seven steps of design D9, one function per step in `plan-units-steps.ts`. Run; PASS.
- [ ] **Step 4:** Write `tests/tools/unit-amend.test.ts`:
  - the scenarios `Amendment unfreezes`, `Add and drop`, `Drop a done unit`, `Invalid replacement` and `Drop a depended-on unit`;
  - `refuses before a lock`;
  - `only the affected units are in the request`;
  - `amending U3 writes records tags.U3 and difficulty.U3`.

  Run; FAIL. Implement. Run; PASS.
- [ ] **Step 5:** Run `bun run test` and `bun run typecheck`; PASS. Commit `feat(tools): plan_units and unit_amend`.

---

## Task 9: Questions and stuck tools — implements 9

**Covers:** 9.1, 9.2
**Difficulty:** Normal
**Blocked by:** Task 8

**Files:**
- Create: `src/tools/spec-question.ts`, `src/tools/spec-stuck.ts`
- Modify: `src/tools/change-tools.ts`
- Test: `tests/tools/spec-question.test.ts`, `tests/tools/spec-stuck.test.ts`

**Interfaces:**
- Consumes: `appendQuestion`, `approverFor`, `runChain`, `completeAnswer`, `registerLivespecTool`, `writeMarked`.
- Produces: the `spec_question` and `spec_stuck` tools.

- [ ] **Step 1:** Write `tests/tools/spec-question.test.ts`:
  - the scenarios `Blocking by default`, `Non-blocking proposal`, `Human reclassifies`, `Answer sends the change back`, `Cascade before the plan` and `Second answer while in define`;
  - `Cap reached`, for the next-step part;
  - `dismissed question stays open`;
  - `reask sends an open question again`;
  - `answer later rewrites the question as non-blocking`, with chains `[in-session, forge]` (forge request pending and async) and `[in-session]` (no request), reading the class back from the snapshot.

  Run; FAIL. Implement. Run; PASS.
- [ ] **Step 2:** Write `tests/tools/spec-stuck.test.ts`:
  - the scenarios `Stuck report waits for a choice`, `Option count enforced` and `Stuck answer lifts the cap`;
  - `recommended must be one of the options`.

  Run; FAIL. Implement. Run; PASS.
- [ ] **Step 3:** Run `bun run test` and `bun run typecheck`; PASS. Commit `feat(tools): spec_question and spec_stuck`.

---

## Task 10: Docs and end-to-end verification — implements 10

**Covers:** 10.1, 10.2, 10.3, 10.4
**Difficulty:** Normal
**Blocked by:** Task 9

**Files:**
- Create: `tests/tools/no-answer-params.test.ts`, `tests/e2e/gates-flow.test.ts`, `openspec/changes/gates-and-decisions/smoke.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: every tool, through `toolHarness` with a scripted UI.
- Produces: the architecture text and the smoke evidence.

- [ ] **Step 1:** Write `tests/tools/no-answer-params.test.ts` with the scenario `Tool has no answer parameter`. It asserts that the parameter schemas of `spec_gate`, `plan_units`, `unit_amend`, `spec_question` and `spec_stuck` have no `outcome`, `choice`, `answer`, `approved`, `difficulty` or `tags` property at any depth. Run; PASS.
- [ ] **Step 2:** Write `tests/e2e/gates-flow.test.ts` with one test, `full gate flow over a memory forge`. The project override sets `loops: { change_iterations: 1 }`. The flow:
  1. a `define` change with a spec diff;
  2. `spec_gate define`, approved in session;
  3. `plan_units`;
  4. `spec_gate plan` with `interaction.adapter: [forge]`, a writer's `/livespec approve`, then `spec_status`, which polls;
  5. a web edit that freezes U2, then `unit_amend U2`, approved;
  6. U1 ticked;
  7. `spec_question` answered with `--changes` that U1 covers.

  It asserts:
  - the change is in define, U1 is unticked and stale, and the count is 1;
  - `spec_gate define` refuses because of the cap;
  - `spec_stuck` followed by `/livespec choose A` lifts the block.

  Run; expect PASS. If it fails, fix the owning task's code, with a regression test there.
- [ ] **Step 3:** Update `docs/architecture.md`:
  - the module lines for `interaction/` and `decide/`;
  - a "Gates and decisions" section: the request lifecycle (request, answer, result), the adapter chain, forge commands, the lock and amendments, cascade, and the derived `change_iterations`;
  - the known gaps that LS-06 closes: same-login command comments through bash, and pack overrides that lower a gate.
- [ ] **Step 4:** Run `bun run typecheck` and `bun run test`, and record the counts in `smoke.md`.
- [ ] **Step 5:** Run a manual smoke and record it in `smoke.md` with the date, the pi version and the outcome:
  - in an interactive pi on a scratch GitHub repository, run `spec_gate define` and approve through the dialog;
  - in `pi -p` with `interaction.adapter: [forge]`, run `spec_gate plan`, comment `/livespec approve` from a writer account, then run `/livespec next` and see `build`.

  If no scratch repository is available, record that and the fallback (the e2e test).
- [ ] **Step 6:** Commit `docs: gates and decisions architecture; e2e gate flow`.

---

## Scenario → test

**approver-adapters**
- Tool has no answer parameter → `tests/tools/no-answer-params.test.ts` › Tool has no answer parameter
- Relayed approval refused → `tests/tools/spec-gate.test.ts` › Relayed approval refused
- Approve in the TUI → `tests/interaction/in-session.test.ts` › Approve in the TUI
- Unavailable without UI → `tests/tools/spec-gate.test.ts` › Unavailable without UI
- Pending gate request → `tests/interaction/forge.test.ts` › Pending gate request
- Duplicate request refused → `tests/interaction/forge.test.ts` › Duplicate request refused
- Approve by a writer → `tests/interaction/forge.test.ts` › Approve by a writer
- Command without write access ignored → `tests/interaction/forge.test.ts` › Command without write access ignored
- Command before the request ignored → `tests/interaction/forge.test.ts` › Command before the request ignored
- Answer that changes a requirement → `tests/interaction/forge.test.ts` › Answer that changes a requirement
- Answer picked up at session start → `tests/interaction/poll.test.ts` › Answer picked up at session start
- Poll failure tolerated → `tests/interaction/poll.test.ts` › Poll failure tolerated
- Crash while applying → `tests/interaction/complete.test.ts` › Crash while applying
- Foreign marked gate ignored → `tests/interaction/complete.test.ts` › Foreign marked gate ignored
- Forge answer recorded → `tests/interaction/complete.test.ts` › Forge answer recorded
- Default chain → `tests/interaction/chain.test.ts` › Default chain
- No adapter available → `tests/interaction/chain.test.ts` and `tests/tools/spec-gate.test.ts` › No adapter available
- Doctor names the adapter → `tests/interaction/doctor.test.ts` › Doctor names the adapter

**phase-gates**
- Blocking question keeps the gate closed → `tests/engine/gates.test.ts`
- Failing check that is not waivable → `tests/engine/gates.test.ts`
- Self gate → `tests/tools/spec-gate.test.ts`
- Registered gate → `tests/tools/spec-gate.test.ts`
- Plan payload → `tests/engine/gates.test.ts`
- Define payload → `tests/engine/gates.test.ts`
- Waive at the gate → `tests/tools/spec-gate.test.ts`
- Approve without waiving → `tests/tools/spec-gate.test.ts`
- Plan gate locks digests → `tests/interaction/complete.test.ts`
- HEAD moved before the answer → `tests/interaction/complete.test.ts`
- Forge approval completes → `tests/interaction/complete.test.ts`
- Issue edited before the answer → `tests/interaction/complete.test.ts`
- Define approved → `tests/tools/spec-gate.test.ts`
- Old approval not reused after a cascade → `tests/tools/spec-gate.test.ts`
- Superseded result does not fall back → `tests/tools/spec-gate.test.ts`
- Failed move retried → `tests/tools/spec-gate.test.ts`
- Ship approved → `tests/tools/spec-gate.test.ts`
- Changes requested → `tests/tools/spec-gate.test.ts`
- Dismissed → `tests/tools/spec-gate.test.ts`

**unit-planning**
- Units written with classification → `tests/tools/plan-units.test.ts`
- Base is an ancestor of HEAD → `tests/tools/plan-units.test.ts`
- Unknown outcome with an unchanged base → `tests/tools/plan-units.test.ts`
- Write conflict keeps the base consistent → `tests/tools/plan-units.test.ts`
- Change start still reconciles → `tests/tools/plan-units.test.ts`
- Merge conflict → `tests/tools/plan-units.test.ts`
- Invalid unit → `tests/tools/plan-units.test.ts`
- Locked plan → `tests/tools/plan-units.test.ts`
- Web edit freezes a unit → `tests/engine/locks.test.ts`
- Tick does not freeze → `tests/engine/locks.test.ts`
- Amendment unfreezes → `tests/tools/unit-amend.test.ts`
- Add and drop → `tests/tools/unit-amend.test.ts`
- Drop a done unit → `tests/tools/unit-amend.test.ts`
- Invalid replacement → `tests/tools/unit-amend.test.ts`
- Drop a depended-on unit → `tests/tools/unit-amend.test.ts`
- Unit finished while the drop was pending → `tests/interaction/complete.test.ts`
- Second plan gate re-locks → `tests/engine/locks.test.ts`
- Plan gate with a stale unit → `tests/engine/gates.test.ts`
- Tag removed in the body → `tests/engine/checks.test.ts`

**questions-and-stuck**
- Blocking by default → `tests/tools/spec-question.test.ts`
- Non-blocking proposal → `tests/tools/spec-question.test.ts`
- Answer written back → `tests/core/question-lines.test.ts`
- Human reclassifies → `tests/tools/spec-question.test.ts`
- Answer sends the change back → `tests/tools/spec-question.test.ts` and `tests/interaction/complete.test.ts`
- Cascade before the plan → `tests/tools/spec-question.test.ts`
- Second answer while in define → `tests/tools/spec-question.test.ts`
- Retried cascade counts once → `tests/interaction/complete.test.ts`
- Cap reached → `tests/tools/spec-question.test.ts` (next step) and `tests/engine/gates.test.ts` (gate refusal)
- Stuck answer lifts the cap → `tests/tools/spec-stuck.test.ts`
- Stuck report waits for a choice → `tests/tools/spec-stuck.test.ts`
- Option count enforced → `tests/tools/spec-stuck.test.ts`
- Choice recorded → `tests/interaction/complete.test.ts`

**decision-seam**
- Rule outcome → `tests/decide/seam.test.ts`
- Rule asks → `tests/decide/seam.test.ts`
- Jev rejected → `tests/decide/registry.test.ts`
- Unknown point → `tests/decide/registry.test.ts`
- Record fields → `tests/decide/records.test.ts`
- Large facts hashed → `tests/decide/records.test.ts`
- Round trip in a PR body → `tests/decide/records.test.ts`
- Override recorded → `tests/interaction/complete.test.ts`
- Agent cannot remove a tag → `tests/tools/plan-units.test.ts`
- Path match → `tests/decide/tags.test.ts`
- Keyword whole word → `tests/decide/tags.test.ts`
- Keyword phrase ignoring case → `tests/decide/tags.test.ts`
- Override adds globs → `tests/decide/tags.test.ts`
- Two capabilities → `tests/decide/difficulty.test.ts`
- Medium default → `tests/decide/difficulty.test.ts`

**flow-engine**
- State from fixture issue, Stale state, Ambiguous phase → `tests/engine/snapshot.test.ts` (existing)
- Pending request and lock from comments → `tests/engine/snapshot.test.ts`
- No unit ready, Last phase, Blocking question first, Missing output, Not started, Next unit, Human gate ready → `tests/engine/next-step.test.ts` (existing)
- Pending gate request, Stuck report first, Frozen unit, Dismissed gate, Ship approved → `tests/engine/next-step.test.ts`
- Counter shown with cap → `tests/engine/next-step.test.ts` (existing); Counter update edits in place → `tests/engine/counters.test.ts` (existing)
- Derived iteration count → `tests/engine/iterations.test.ts`

**flow-pack**
- Default pack loads, Default pack contents, Spot check → `tests/engine/pack-load.test.ts` (fixture updated)
- Replace one key, Replace a skills list, Add a phase, Merge loops, Error points at override → `tests/engine/pack-load.test.ts` (existing)
- Decisions merge through the rule → `tests/engine/pack-load.test.ts`

**init-and-doctor**
- Unknown key → `tests/config.test.ts` (existing)
- Interaction adapter list → `tests/config.test.ts`
- Unknown adapter name → `tests/config.test.ts`

**context-injection**
- Card contents, Stale card, Registered section → `tests/hooks/phase-card.test.ts` (existing)
- Pending approvals shown → `tests/hooks/phase-card.test.ts`
- Ignored command shown → `tests/hooks/phase-card.test.ts`
