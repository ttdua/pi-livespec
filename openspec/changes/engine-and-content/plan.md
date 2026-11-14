# Engine, Flow Pack and agent-skills Content Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Make the livespec flow run: load the YAML flow pack, derive each change's state from the issue and git, compute the next step, inject the routing note and phase card, manage the agent-skills clone, and add `init`, `doctor`, `next`, `skills` and the first change tools.

**Architecture:** Pure decision modules (pack schema and merge, `nextStep`, `renderCard`, `decideUpgrade`, section helpers) sit behind thin I/O shells (snapshot reader, git and mirror wrappers, pi hooks, commands, tools). A `Session` holds only derived data for the current pi session and is rebuilt from the forge and git. Later specs extend the flow through a registry, not by editing these modules.

**Tech Stack:** TypeScript (ESM, `.ts` imports, `strict`), `yaml` (only runtime dependency), the `git` executable, vitest, bun, pi `ExtensionAPI`.

**Spec:** `openspec/changes/engine-and-content/specs/` (six capabilities) and `openspec/changes/engine-and-content/design.md`.

## Global Constraints

- `dependencies` stays exactly `{ "yaml": ... }`; no new runtime or dev dependency.
- Use `bun` and `bunx` only; tests run with `bun run test`, types with `bun run typecheck`.
- All code, comments, docs and commit messages are in English.
- Tests make no network call beyond loopback; git upstreams in tests are local bare repositories under a temp directory; `$HOME` paths are injected, never the real `~/.pi`.
- Never push, never install git hooks, never edit pi settings files.
- A livespec hook never throws into pi: every hook catches and degrades.
- Forge text shown to the model is wrapped in `<untrusted>…</untrusted>`.
- Skills never exposed: `using-agent-skills`, `context-engineering`.
- Each scenario test is named exactly after its `#### Scenario:` title.
- Coding standards: `~/.agents/skills/coding-standards/SKILL.md` — one responsibility per module; no god closure in `extension.ts` or `session.ts`.

## Review Focus

1. **Hook failures.** A forge error inside `context` or `before_agent_start` (auth expired mid-session) must leave the agent working, with a card that says the forge is unavailable. Test in Task 7: `context hook survives a throwing forge`.
2. **Malformed override shapes.** `.pi/livespec/flow.yaml` with `phases:` as a map, a scalar file, or an empty file must give positioned errors, never a crash. Test in Task 1: `override with non-list phases reports an error`.
3. **CRLF issue bodies.** Forge bodies may use `\r\n`. `spec_write` must keep every other line byte-identical, line endings included. Test in Task 2: `replaceSection keeps CRLF endings`.
4. **Upgrade during a running session.** `current` switches while a session keeps reading skills, so the exposed paths must be real `<sha>` paths. Test in Task 5: `exposed paths resolve to the sha tree, not current`.
5. **Branch and title mismatch.** On `livespec/rate-limit`, the issue titled `rate-limit` may have no `Branch:` yet, or two issues may claim the branch. Tests in Task 4: `resolves by title with a warning` and `several matches is an error`.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `Pack` | new | `{ name: string; version: 1; content: string; limits: Record<string, number>; loops: Record<string, number>; decisions: Record<string, unknown>; init: { skills: string[] }; phases: Phase[] }` | yes |
| `Phase` | new | `{ id: string; requires: string[]; per?: "unit"; skills: { required: string[]; optional: string[] }; outputs: PhaseOutput[]; redirects: string[]; checks: string[]; gate: "none" \| "self" \| "human"; subagents: unknown[] }`. Absent keys get `[]` or `gate: "none"` | yes |
| `PhaseOutput` | new | `"issue#Capabilities" \| "issue#Proposal" \| "issue#Design" \| "issue#Units" \| "specs-diff"` | yes |
| `PackError` | new | `{ severity: "error" \| "warning"; file: string; line: number; col: number; path: string; message: string }`. `line` and `col` are 1-based | yes |
| `LoadedPack` | new | `{ ok: true; pack: Pack; warnings: PackError[] } \| { ok: false; errors: PackError[] }` | yes |
| `loadPack` | new | `loadPack(root: string, deps?: { readFile?(p: string): Promise<string \| undefined> }): Promise<LoadedPack>` in `src/engine/pack-load.ts` | yes |
| `validatePackDocument` | new | `validatePackDocument(doc: yaml.Document, file: string, lc: yaml.LineCounter, mode: "pack" \| "override"): PackError[]` in `src/engine/pack-schema.ts` | no |
| `mergePack` | new | `mergePack(base: ParsedPack, override: ParsedPack): { pack: Pack; origins: Map<string, { file: string; line: number; col: number }> }`. `ParsedPack = { file: string; value: Record<string, unknown>; lc: LineCounter; doc: Document }` | no |
| `SubSchema` | new | `{ validate(node: yaml.Node \| null, report: (node: yaml.Node, message: string) => void): void; personas?(value: unknown): string[] }` | yes |
| `registerPackSchema` | new | `registerPackSchema(key: "decisions" \| "subagents", schema: SubSchema): void` | yes |
| `personasForPack` | new | `personasForPack(pack: Pack): string[]` in `src/engine/registry.ts`. It applies the `decisions` schema's `personas` to `pack.decisions` and the `subagents` schema's `personas` to each `phase.subagents`, then returns the sorted unique union. It returns `[]` when no schema defines `personas` | yes |
| `CheckContext` / `CheckFn` | new | `CheckContext = { root: string; change: Change; git: CheckGit }`. `CheckGit = { diff(from: string, to: string, path: string): Promise<string> }`, which the full `Git` (Task 4) satisfies structurally. `CheckFn = (ctx: CheckContext) => Promise<Result[]>` (`Result` from `src/core/result.ts`). All of these live in `src/engine/registry.ts` | yes |
| `registerCheck` | new | `registerCheck(name: string, fn: CheckFn): void`; `checkNames(): string[]`; `getCheck(name: string): CheckFn \| undefined` in `src/engine/registry.ts` | yes |
| `resetRegistryForTests` | new | `resetRegistryForTests(): void` in `src/engine/registry.ts`. It clears pack sub-schemas and checks; built-in checks re-register through `registerBuiltinChecks()` (Task 4) | no |
| `registerCardSection` | new | `registerCardSection(name: string, render: (i: CardInput) => string \| undefined): void` in `src/hooks/phase-card.ts` (Task 7) | yes |
| `DoctorResult` | new | `{ id: string; status: "ok" \| "warn" \| "error"; message: string; suggestion?: string }` | yes |
| `registerDoctorCheck` | new | `registerDoctorCheck(id: string, run: (d: DoctorDeps) => Promise<DoctorResult[]>): void` in `src/commands/doctor.ts` (Task 6) | yes |
| `registerWorkInProgress` | new | `registerWorkInProgress(fn: (forge: Forge) => Promise<WorkInProgress>): void` in `src/content/wip.ts` (Task 5). `WorkInProgress = { busy: boolean; change?: number; reason?: string }`. The last registered predicate wins; the default is the build-phase rule | yes |
| `sectionText` / `replaceSection` / `setHeaderLine` | new | `sectionText(body: string, name: string): string \| undefined`; `replaceSection(body: string, name: string, content: string): string`; `setHeaderLine(body: string, key: string, value: string): string`. Canonical H2 order: `Proposal, Design, Questions, Units, Durable docs` | yes |
| `ProjectConfig` | new | `{ forge?: "github" \| "gitea"; host?: string; githubHosts: string[]; giteaUrl?: string; integrationBranch?: string; agentSkillsChannelSet: boolean }` | yes |
| `UserConfig` / `Channel` | new | `UserConfig = { agentSkills: { channel: Channel } }`. `Channel = "auto" \| "notify" \| "pinned"`, default `auto` | yes |
| `loadConfig` | new | `loadConfig(root: string, home: string): Promise<{ project: ProjectConfig \| null; user: UserConfig; warnings: string[] }>`. `project === null` means the project is not initialized | yes |
| Config files | new | Project `.pi/livespec/config.yaml` keys: `forge, host, githubHosts, giteaUrl, integrationBranch`. User `~/.pi/agent/livespec/config.yaml` key: `agentSkills.channel`. Unknown keys produce warnings | yes |
| `Git` | new | `interface Git { branch(): Promise<string>; head(): Promise<string>; isDirty(): Promise<boolean>; diff(from: string, to: string, path: string): Promise<string>; originHead(): Promise<string \| undefined>; fetch(remote: string, ref: string): Promise<void>; revParse(ref: string): Promise<string>; switchCreate(name: string, at: string): Promise<void>; switchTo(name: string): Promise<void>; deleteBranch(name: string): Promise<void>; branchExists(name: string): Promise<boolean>; configGet(key: string): Promise<string \| undefined>; configSet(key: string, value: string): Promise<void> }`; `createGit(root: string, exec?: GitExec): Git`. "Not found" exit codes map to values: `originHead` returns `undefined` on exit 128 from `symbolic-ref`; `configGet` returns `undefined` on exit 1 from `config --get`; `branchExists` uses `show-ref --verify --quiet refs/heads/<name>` and returns `false` on exit 1. Every other non-zero exit throws `GitError { args; code; stderr }` | yes |
| `GitExec` | new | `GitExec = (args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>` in `src/engine/git-exec.ts`; `defaultGitExec` uses `node:child_process.execFile("git", args, { cwd, env: { ...process.env, ...env } })` and resolves on any exit. This is separate from the forge `ExecFn`, because the mirror needs per-call `env` (`GIT_INDEX_FILE`) and the forge API stays unchanged | no |
| `integrationBranch` | new | `integrationBranch(project: ProjectConfig, git: Git): Promise<string \| undefined>` | yes |
| `filterMarked` | new (additive in `src/forge/markers.ts`) | `filterMarked(comments: Comment[], login: string): MarkedReadResult`. `readMarkedComments` calls it; its behavior is unchanged | yes |
| `CommentsCache` | new | `class CommentsCache { constructor(o: { dir: string; now?: () => number; ttlMs?: number }); list(forge: Forge, issue: Issue): Promise<{ comments: Comment[]; stale: boolean }>; invalidate(n: number): Promise<void> }`. `ttlMs` defaults to `300_000` | yes |
| Comments cache file | new | `<cacheRoot>/<host>/<owner>/<repo>/<n>.comments.json` = `{ updatedAt: string; fetchedAt: number; comments: Comment[] }` | no |
| Marker kind `skill-note` | new | id `<phase>.<skill>`, data `{ phase: string; skill: string; reason: string }` | yes |
| Marker kind `counter` (use) | new use of a core kind | id `<loop>` or `<loop>.<unit>`, data `{ value: number }` | yes |
| `readCounters` / `setCounter` | new | `readCounters(marked: MarkedComment[]): Record<string, number>`; `setCounter(forge: Forge, n: number, id: string, value: number, marked: MarkedComment[]): Promise<void>` | yes |
| `ChangeState` | new | `{ issue: { number: number; title: string; labels: string[] }; phase: { kind: "ok"; id: string } \| { kind: "missing" } \| { kind: "ambiguous"; ids: string[] }; change: Change; sections: Record<"Capabilities" \| "Proposal" \| "Design" \| "Units", boolean>; counters: Record<string, number>; skillNotes: string[]; incomplete: string[]; git: { branch: string; head: string; dirty: boolean; specsChanged: boolean \| undefined }; checks: CheckResult[]; stale: boolean; readOnly: boolean; warnings: string[] }`. `specsChanged` is `undefined` when there is no `Base`, and otherwise tells whether `git diff <Base>..HEAD -- specs/` is non-empty. `Capabilities` counts as present when the line exists and declares at least one capability | yes |
| `readChangeSnapshot` | new | `readChangeSnapshot(d: SnapshotDeps, n: number): Promise<Omit<ChangeState, "checks">>`. `SnapshotDeps = { forge: Forge; isReadOnly(): boolean; git: Git; comments: CommentsCache }` | yes |
| `runChecks` | new | `runChecks(pack: Pack, state: Omit<ChangeState, "checks">, ctx: { root: string; git: Git }): Promise<CheckResult[]>`. Modified during apply (Task 4, user decision 2026-11-14): `CheckResult = Result & { check: string }`, so the next-step sentence can name the check (`Fix spec-format: …`). `ChangeState.checks` and `NextStep.checks` use `CheckResult[]` too | yes |
| `NextStep` | new | `{ phase: string \| undefined; required: string[]; optional: string[]; redirects: string[]; checks: CheckResult[]; blockingQuestions: Question[]; counters: { name: string; value: number; cap?: number }[]; activeUnits: string[]; blockedUnits: { id: string; waitingOn: string[] }[]; incomplete: string[]; advance?: string; next: string }` | yes |
| `nextStep` / `successorOf` | new | `nextStep(pack: Pack, state: ChangeState): NextStep` (pure, valid pack only); `successorOf(pack: Pack, phase: string): string \| undefined` | yes |
| `advancePhase` | new | `advancePhase(forge: Forge, n: number, to: string, pack: Pack): Promise<{ status: "moved"; from: string } \| { status: "unchanged" } \| { status: "refused"; reason: string }>` | yes |
| `resolveChange` | new | `resolveChange(forge: Forge, branch: string): Promise<{ kind: "change"; number: number; warning?: string } \| { kind: "none"; open: OpenChange[] } \| { kind: "error"; message: string }>`. `OpenChange = { number: number; title: string; phase?: string }`, capped at 10 | yes |
| `ContentPaths` | new | `contentPaths(home: string): { root; mirror; current; lock; tree(sha: string): string; staging(sha: string): string }`. `root = <home>/.pi/agent/livespec/agent-skills` | no |
| `Lock` file `livespec.lock` | new | YAML `{ source: string; commit: string; pinned: string \| null; history: string[]; skipped: string[]; checkedAt: string \| null }` | yes |
| `readLock` / `writeLock` | new | `readLock(path: string): Promise<Lock \| undefined>`; `writeLock(path: string, lock: Lock): Promise<void>`. The write goes to a temp file and is renamed | no |
| `Mirror` | new | `createMirror(paths: ContentPaths, exec: GitExec): { ensure(source: string): Promise<void>; fetch(): Promise<string>; checkout(sha: string, dir: string): Promise<void>; resolve(ref: string): Promise<string> }`. `checkout` passes `env: { GIT_INDEX_FILE: <tmp file> }` through `GitExec` and never touches `process.env` | no |
| `checkCompat` | new | `checkCompat(tree: string, pack: Pack): Promise<{ ok: boolean; failures: { item: string; reason: string }[] }>` | yes |
| `decideUpgrade` | new | `decideUpgrade(i: { channel: Channel; lock: Lock; now: Date; head: string; workInProgress: WorkInProgress; manual: boolean }): { kind: "skip"; reason: string } \| { kind: "notify"; sha: string } \| { kind: "install"; sha: string }` (pure) | yes |
| `CloneResult` | new | `{ kind: "exists"; sha: string } \| { kind: "installed"; sha: string } \| { kind: "failed"; reason: string; failures?: { item: string; reason: string }[] }` | yes |
| `ContentManager` | new | `class ContentManager { constructor(d: { paths: ContentPaths; mirror: Mirror; now: () => Date; source: string }); clone(pack: Pack): Promise<CloneResult>; status(channel: Channel): Promise<string>; autoCheck(pack: Pack, channel: Channel, wip: WorkInProgress): Promise<UpgradeOutcome>; update(pack: Pack, wip: WorkInProgress): Promise<UpgradeOutcome>; pin(sha: string, pack: Pack, wip: WorkInProgress): Promise<UpgradeOutcome>; unpin(): Promise<void>; rollback(): Promise<UpgradeOutcome>; activeTree(): Promise<string \| undefined> }`. `UpgradeOutcome = { kind: "installed"; sha: string; changed: SkillChanges } \| { kind: "skipped" \| "refused" \| "failed"; reason: string; failures?: { item: string; reason: string }[] } \| { kind: "notified"; sha: string }`. `SkillChanges = { added: string[]; removed: string[]; changed: string[] }` | yes |
| `exposedSkillPaths` | new | `exposedSkillPaths(i: { initialized: boolean; pack: LoadedPack; activeTree?: string }): string[]`; `EXCLUDED_SKILLS = ["using-agent-skills", "context-engineering"] as const` | yes |
| `ROUTING_NOTE` | new | `export const ROUTING_NOTE: string`, set as `systemPromptOptions.sections["livespec"]` | yes |
| `CardInput` / `renderCard` | new | `CardInput = { first: boolean; constraintsTemplate: boolean; unnotedSkills: string[] } & ({ kind: "change"; step: NextStep; state: ChangeState } \| { kind: "list"; open: OpenChange[] } \| { kind: "pack-errors"; errors: PackError[] } \| { kind: "forge-unavailable"; message: string })`; `renderCard(i: CardInput): string` (pure) | yes |
| Phase card message | new | `{ role: "user", customType: "livespec-phase-card", content: string }`, appended by `context` and never persisted | yes |
| `Session` | new | `class Session { readonly cwd: string; config; pack: LoadedPack; forge?: CachedForge; card: CardInput; refresh(): Promise<void> }` plus `getSession(): Session \| undefined` and `setSession(s: Session \| undefined): void` in `src/hooks/session-store.ts` | no |
| `TEMPLATE_MARKER` | new | `export const TEMPLATE_MARKER = "<!-- livespec:template -->"` in `src/core/templates.ts` (Task 2) | yes |
| `runInit` | new | `runInit(root: string, d: InitDeps): Promise<{ created: string[]; kept: string[]; failed: { path: string; reason: string }[] }>`. `InitDeps = { content: Pick<ContentManager, "clone" \| "activeTree">; pack: () => Promise<LoadedPack> }`. When the pack is invalid, init still writes files and reports the clone as failed with the pack errors | yes |
| `afterForgeWrite` | new | `afterForgeWrite(session: Session, issue: number): Promise<void>` in `src/tools/guard.ts`. It calls `comments.invalidate(issue)` and then `session.refresh()`. Every tool that writes to the forge calls it after a successful write | no |
| `isKebabName` | new | `isKebabName(s: string): boolean` = `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` in `src/core/names.ts` (Task 2). Used by `spec_write` (Capabilities), `change_new` and the title check of `change_start` | yes |
| `runDoctor` / `DoctorDeps` | new | `runDoctor(d: DoctorDeps): Promise<DoctorResult[]>`. `DoctorDeps = { root: string; home: string; initialized: boolean; pack: LoadedPack; loadedSkills: { name: string; filePath: string }[]; isTrusted: boolean; content: ContentManager; forge: () => Promise<{ forge: Forge; readOnly: boolean }>; exists(p: string): Promise<boolean>; listDir(p: string): Promise<string[]> }` | yes |
| `/livespec` subcommands | modified | `init`, `doctor`, `next`, `skills status \| update \| pin <sha> \| unpin \| rollback` join `validate` and `migrate-openspec`. `USAGE = "Usage: /livespec [validate \| migrate-openspec \| init \| doctor \| next \| skills <status\|update\|pin <sha>\|unpin\|rollback>]"` | yes |
| Tool `spec_status` | new | params `{}`; details `{ state: ChangeState \| null; open?: OpenChange[] }` | yes |
| Tool `spec_next` | new | params `{}`; details `{ step: NextStep \| null; open?: OpenChange[] }` | yes |
| Tool `skill_note` | new | params `{ skill: string; reason: string }` | yes |
| Tool `spec_write` | new | params `{ section: "Capabilities" \| "Product impact" \| "Proposal" \| "Design"; content: string }`. The `Units` section is refused with a message naming `plan_units` (LS-05) | yes |
| Tool `change_new` | new | params `{ name: string }`; details `{ number: number }` | yes |
| Tool `change_start` | new | params `{ issue: number }`; details `{ branch: string; base: string; reconciled: boolean }` | yes |
| Git config key | new | `branch.livespec/<name>.livespecBase = <full sha>` | yes |
| Default pack file | new | `src/packs/agent-skills.yaml`, with the content of issue #4 | yes |

---

## Task 1: Flow pack loader and registry — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Create: `src/engine/registry.ts`, `src/engine/pack-schema.ts`, `src/engine/pack-merge.ts`, `src/engine/pack-load.ts`, `src/engine/pack-types.ts`, `src/packs/agent-skills.yaml`, `tests/fixtures/agent-skills.pack.json`
- Test: `tests/engine/registry.test.ts`, `tests/engine/pack-schema.test.ts`, `tests/engine/pack-load.test.ts`

**Interfaces:**
- Consumes: `Change` (`src/core/change.ts`) and `Result` (`src/core/result.ts`), as types only.
- Produces: `Pack`, `Phase`, `PhaseOutput`, `PackError`, `LoadedPack`, `loadPack`, `SubSchema`, `registerPackSchema`, `personasForPack`, `CheckContext`, `CheckGit`, `CheckFn`, `registerCheck`, `checkNames`, `getCheck`, `resetRegistryForTests`. Task 4 registers the four built-in checks. The card, doctor and work-in-progress registries live with their owners (Tasks 7, 6 and 5).

- [ ] **Step 1:** Write `tests/engine/registry.test.ts`:
  - `registerCheck adds a name`;
  - `resetRegistryForTests clears registered checks and schemas`;
  - `registerPackSchema replaces an earlier schema for the same key`;
  - `personasForPack collects personas from decisions and every phase subagents`;
  - `personasForPack is empty without schemas`.
- [ ] **Step 2:** Run `bun run test tests/engine/registry.test.ts`; expect FAIL (module missing).
- [ ] **Step 3:** Implement `src/engine/registry.ts` per Contracts, with module-level maps.
- [ ] **Step 4:** Copy the default pack from issue #4 into `src/packs/agent-skills.yaml`, and its JSON transcription into `tests/fixtures/agent-skills.pack.json`.
  - Normalize absent keys: `requires: []`, `skills.optional: []`, `outputs: []`, `redirects: []`, `checks: []`, `gate: "none"`, `subagents: []`.
- [ ] **Step 5:** Write `tests/engine/pack-schema.test.ts`.
  - Spec scenarios: `Wrong type`, `Wrong gate value`, `Unknown key`, `Model key rejected`, `YAML syntax error`, `Unregistered subagents`, `Registered sub-schema`.
  - Review Focus 2: `override with non-list phases reports an error`, `empty override file reports an error`.
  - Every test asserts the exact `{ file, line, col }`. Example: a fixture string where `gate: maybe` sits on line 12 must report `line: 12, col: 11`.
- [ ] **Step 6:** Run; expect FAIL.
- [ ] **Step 7:** Implement `validatePackDocument`.
  - Parse with `const lc = new LineCounter(); parseDocument(text, { keepSourceTokens: false, lineCounter: lc })`. The counter must be passed in, or positions are wrong.
  - Walk the `YAMLMap` and `YAMLSeq` nodes.
  - Report at `lc.linePos(node.range[0])`.
  - YAML errors come from `doc.errors[i].linePos[0]`.
  - Model and lane keys (`model`, `models`, `lanes`, `lane_count`) report "packs never name models or lane counts (ADR 0005)".
  - An unregistered non-empty `decisions` or `subagents` reports "no spec has registered `<key>`".
- [ ] **Step 8:** Run; expect PASS.
- [ ] **Step 9:** Write `tests/engine/pack-load.test.ts`. Its `beforeEach` registers stub checks named `spec-format`, `units-format`, `done-maps-scenarios` and `capabilities-match-diff`, because the real ones arrive in Task 4.
  - Spec scenarios: `Default pack loads`, `Default pack contents` (deep-equals the fixture), `Spot check`, `Requires cycle`, `Replace one key`, `Replace a skills list`, `Add a phase`, `Merge loops`, `Error points at override`, `Unknown extends`, `Name changed`, `Standalone pack`, `Registered check name`.
  - Also `excluded skills produce warnings` and `duplicate phase id is an error`.
- [ ] **Step 10:** Run; expect FAIL.
- [ ] **Step 11:** Implement `mergePack` in `pack-merge.ts` and `loadPack` in `pack-load.ts`.
  - Read `src/packs/agent-skills.yaml` with `new URL("../packs/agent-skills.yaml", import.meta.url)`.
  - Read the optional `<root>/.pi/livespec/flow.yaml`.
  - Merge as `design.md` says: phases by `id`, keys replaced one by one, maps one level deep.
  - Semantic checks: unique ids, known `requires`, a DFS for cycles, `checkNames()`, outputs, excluded-skill warnings.
  - Record the origin of each phase key, so a semantic error points at the override's node.
- [ ] **Step 12:** Run the tests and `bun run typecheck`; expect PASS.
- [ ] **Step 13:** Commit `feat(engine): flow pack schema, loader and registry`.

---

## Task 2: Byte-preserving section helpers — implements 2

**Covers:** 2.1
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/core/sections.ts`, `src/core/templates.ts` (only `TEMPLATE_MARKER`), `src/core/names.ts` (`isKebabName`)
- Test: `tests/core/sections.test.ts`, `tests/core/names.test.ts`

**Interfaces:**
- Consumes: `splitLines` and `joinLines` from `src/core/lines.ts`; `parseChange` from `src/core/change.ts`.
- Produces: `sectionText`, `replaceSection`, `setHeaderLine`, `TEMPLATE_MARKER`, `isKebabName`.

- [ ] **Step 1:** Write the tests over `tests/fixtures/change-body.md`:
  - `sectionText returns the Proposal body`;
  - `replaceSection keeps every other line byte-identical`;
  - `replaceSection creates Design after Proposal`;
  - `replaceSection creates Proposal before Questions when both are missing`;
  - `setHeaderLine replaces an existing ownership line`;
  - `setHeaderLine inserts a missing key before the first H2`;
  - `replaceSection keeps CRLF endings` (Review Focus 3).

  Assert unchanged lines with `splitLines(out).filter(...)` against the input lines.
- [ ] **Step 2:** Run `bun run test tests/core/sections.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement the three functions per Contracts.
  - A section runs from its `## <name>` line to the next `## ` line or the end of the body.
  - New lines take the EOL of the body's first line.
  - `content` is trimmed of trailing newlines and written followed by one blank line, unless the section is the last one.
- [ ] **Step 4:** Run the tests and typecheck; expect PASS.
- [ ] **Step 5:** Write `tests/core/names.test.ts`. `rate-limit` and `a1` are accepted. `-bad`, `bad-`, `bad--name`, `Rate` and the empty string are rejected. Run; expect FAIL. Implement `isKebabName`. Run; expect PASS.
- [ ] **Step 6:** Commit `feat(core): byte-preserving section helpers and name check`.

---

## Task 3: Config files and git runner — implements 3

**Covers:** 3.1, 3.2
**Difficulty:** Easy
**Blocked by:** none

**Files:**
- Create: `src/config.ts`, `src/engine/git-exec.ts`
- Test: `tests/config.test.ts`, `tests/engine/git-exec.test.ts`

**Interfaces:**
- Produces: `ProjectConfig`, `UserConfig`, `Channel`, `loadConfig`, `GitExec`, `defaultGitExec`. Task 3 is the only writer of `src/engine/git-exec.ts`; Tasks 4 and 5 consume it.

- [ ] **Step 1:** Write the tests:
  - `Unknown key` (the spec scenario: `integrationBrnach` gives a warning that names it);
  - `missing project file means not initialized`;
  - `Default channel` (the agent-skills-content scenario: no user config gives `auto`);
  - `invalid channel value is a warning and falls back to auto`;
  - `project agentSkills.channel is flagged`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `loadConfig`.
  - Parse both files with `yaml.parse`.
  - Known project keys: `forge`, `host`, `githubHosts`, `giteaUrl`, `integrationBranch`, `agentSkills`.
  - Known user key: `agentSkills`.
  - `detectForge` keeps its own reader.
- [ ] **Step 4:** Run the tests and typecheck; expect PASS.
- [ ] **Step 5:** Write `tests/engine/git-exec.test.ts`:
  - `resolves with a non-zero code instead of rejecting`;
  - `per-call env reaches git` (run `git var GIT_AUTHOR_IDENT` with `env: { GIT_AUTHOR_NAME: "probe" }`, and the output contains `probe`);
  - `env does not leak into process.env`.

  Run; expect FAIL. Implement `GitExec` and `defaultGitExec` per Contracts. Run; expect PASS.
- [ ] **Step 6:** Commit `feat: project and user config, git runner`.

---

## Task 4: Engine state, checks and next step — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
**Difficulty:** Very Hard
**Blocked by:** Task 1, Task 2, Task 3

**Files:**
- Create:
  - `src/engine/git.ts`, `src/engine/comments-cache.ts`, `src/engine/checks.ts`, `src/engine/snapshot.ts`, `src/engine/next-step.ts`;
  - `src/engine/counters.ts`, `src/engine/advance.ts`, `src/engine/resolve-change.ts`, `src/engine/state-types.ts`.
- Modify:
  - `src/forge/markers.ts`: add `filterMarked`; `readMarkedComments` calls it.
  - `src/engine/pack-load.ts`: add a side-effect `import "./checks.ts"`, so built-in checks are registered before any pack is validated.
- Test:
  - `tests/engine/git.test.ts`, `tests/engine/comments-cache.test.ts`, `tests/engine/checks.test.ts`, `tests/engine/snapshot.test.ts`, `tests/engine/next-step.test.ts`;
  - `tests/engine/counters.test.ts`, `tests/engine/advance.test.ts`, `tests/engine/resolve-change.test.ts`.

**Interfaces:**
- Consumes:
  - `Pack`, `registerCheck` and `checkNames` (Task 1);
  - `sectionText` (Task 2);
  - `ProjectConfig`, `GitExec` and `defaultGitExec` (Task 3);
  - `Forge`, `CachedForge`, `phaseLabel`, `registerKind`, `writeMarked` and `parseMarked` (LS-03);
  - `parseChange`, `validateUnits`, `checkDoneMapsScenarios`, `capabilitiesMatchDiff`, `parseSpec` and `validateSpec` (LS-02).
- Produces: `Git`, `GitError`, `createGit`, `integrationBranch`, `CommentsCache`, `filterMarked`, `readCounters`, `setCounter`, `ChangeState`, `readChangeSnapshot`, `runChecks`, `registerBuiltinChecks(): void`, `NextStep`, `nextStep`, `successorOf`, `advancePhase`, `resolveChange`, `OpenChange`.

Use `tests/forge/memory-forge.ts` as the forge in every test, and temporary repos from `tests/helpers/repo.ts` for git.

- [ ] **Step 1:** Write `tests/engine/git.test.ts`:
  - `integrationBranch prefers config` (the `Config wins` scenario test itself lives in Task 8), `Default branch`, `Cannot resolve` (via `integrationBranch`);
  - `isDirty detects untracked files`;
  - `configSet then configGet round-trips`;
  - `configGet returns undefined for a missing key`;
  - `branchExists is false for a missing branch`;
  - `unexpected git failure throws GitError with stderr`.

  Run; expect FAIL. Implement `createGit` over `GitExec` (Task 3). The exit code mapping follows the `Git` contract.

  Run; expect PASS.
- [ ] **Step 2:** Write `tests/engine/comments-cache.test.ts`:
  - `Comments cache hit`, `Account switch`, `Own write invalidates`;
  - `entry older than 5 minutes is refetched`;
  - `read-only mode serves cached comments as stale`.

  Run; expect FAIL. Implement `CommentsCache` (raw comments, key `updatedAt` plus `ttlMs`) and `filterMarked`, then `registerKind("skill-note")` at module load of `src/engine/comments-cache.ts`. Run; expect PASS. Also rerun `tests/forge/markers.test.ts`, which must stay green.
- [ ] **Step 3:** Write `tests/engine/checks.test.ts`:
  - `Units check in plan`, `Only active phase checks`, `Capabilities mismatch`;
  - `spec-format validates declared capabilities only`.

  Run; expect FAIL. Implement `src/engine/checks.ts`. `registerBuiltinChecks()` registers the four checks and runs at module load; `runChecks` looks each phase check up with `getCheck`. Add the side-effect import in `pack-load.ts`, and add the test `default pack validates without stub checks` to `tests/engine/pack-load.test.ts`.
  - `spec-format` validates `specs/<cap>/spec.md` for each declared capability, through `parseSpec` and `validateSpec`.
  - `capabilities-match-diff` uses `git.diff(base, "HEAD", "specs/")`.

  Run; expect PASS.
- [ ] **Step 4:** Write `tests/engine/snapshot.test.ts`:
  - `State from fixture issue`, `Stale state`, `Ambiguous phase`;
  - `incomplete markers are collected`;
  - `specsChanged reflects the diff from Base`;
  - `specsChanged is undefined without Base`.

  Seed the memory forge with `tests/fixtures/change-body.md` and the labels `livespec`, `livespec:phase/build`. Run; expect FAIL. Implement `readChangeSnapshot`. Run; expect PASS.
- [ ] **Step 5:** Write `tests/engine/next-step.test.ts` as a table over hand-built `ChangeState` values and the default pack:
  - `Pure`, `No unit ready`, `Last phase`, `Blocking question first`, `Missing output`, `Not started`, `Next unit`, `Human gate ready`;
  - `Build with pending units does not advance`, `Branching custom pack`, `Custom successor`, `Completed build with a human gate`, `Counter shown with cap`;
  - `self gate passes when checks pass`, `phase missing asks to repair labels`;
  - `specs-diff output missing without checks` (a custom phase with `outputs: [specs-diff]`, `checks: []` and `specsChanged: false`);
  - `specs-diff output present` (`specsChanged: true`).

  Assert the exact `next` strings defined in Step 6. Run; expect FAIL.
- [ ] **Step 6:** Implement `nextStep` and `successorOf`. The precedence is in `design.md`. The sentences are fixed copy, for stable tests and a stable card:
  - missing → `"Repair labels: the issue has no livespec:phase/* label."`
  - ambiguous → `"Repair labels: the issue has several phase labels (<a>, <b>); rerun the phase move."`
  - not started → `"Run change_start #<n> to create the change branch."`
  - question → `"Answer blocking question <Qn> before continuing."`
  - output → `"Write <Section> with spec_write."`. For `specs-diff` with `specsChanged !== true` → `"Edit specs/ for the declared capabilities."`. `issue#Units` is written by LS-05, so the sentence is `"Write Units (the plan_units tool arrives with LS-05)."`
  - check → `"Fix <check>: <first result message>."`
  - unit → `"Build <Un> — <title>."`
  - blocked → `"No unit is ready: <Un> waits on <Um>[, …]."`
  - human gate → `"Ready for the <phase> gate."`
  - self gate → `"Checks pass; the <phase> gate can pass."`
  - none gate → `"Move to <successor>."` with `advance` set
  - last phase → `"The flow has no further phase."`

  Run; expect PASS.
- [ ] **Step 7:** Write `tests/engine/counters.test.ts`: `Counter update edits in place`, `setCounter creates when missing`. Run; expect FAIL. Implement the counters. Run; expect PASS.
- [ ] **Step 8:** Write `tests/engine/advance.test.ts`:
  - `Forward move`, `Skip refused`, `Partial failure` (a memory forge wrapper whose `removeLabels` throws once);
  - `Normal move unaffected`, `Retry completes the move`, `Already moved`, `Three phase labels`;
  - `backward move allowed`.

  Run; expect FAIL. Implement `advancePhase`. Run; expect PASS.
- [ ] **Step 9:** Write `tests/engine/resolve-change.test.ts`:
  - `resolves by Branch line`;
  - `resolves by title with a warning` (Review Focus 5);
  - `several matches is an error` (Review Focus 5);
  - `other branch lists open changes capped at 10`.

  Run; expect FAIL. Implement `resolveChange` with `searchIssues({ labels: ["livespec"], state: "open" })`. Run; expect PASS.
- [ ] **Step 10:** Run `bun run test tests/engine tests/forge` and `bun run typecheck`; expect PASS.
- [ ] **Step 11:** Commit `feat(engine): change state, named checks and next step`.

---

## Task 5: agent-skills content — implements 5

**Covers:** 5.1, 5.2, 5.3, 5.4, 5.5
**Difficulty:** Hard
**Blocked by:** Task 1, Task 3

**Files:**
- Create: `src/content/paths.ts`, `src/content/lock.ts`, `src/content/mirror.ts`, `src/content/compat.ts`, `src/content/upgrade.ts`, `src/content/manager.ts`, `src/content/expose.ts`, `src/content/wip.ts`
- Test: `tests/content/helpers.ts` (makes a local bare upstream with the skill dirs of the default pack plus `agents/`), `tests/content/compat.test.ts`, `tests/content/upgrade.test.ts`, `tests/content/manager.test.ts`, `tests/content/expose.test.ts`

**Interfaces:**
- Consumes: `Pack`, `LoadedPack` and `personasForPack` (Task 1); `Channel` (Task 3); `GitExec` and `defaultGitExec` (Task 3); `Forge` and `parseChange` (LS-02/LS-03).
- Produces: `contentPaths`, `Lock`, `readLock`, `writeLock`, `createMirror`, `checkCompat`, `decideUpgrade`, `ContentManager`, `CloneResult`, `UpgradeOutcome`, `SkillChanges`, `exposedSkillPaths`, `EXCLUDED_SKILLS`.
- Also produces `WorkInProgress`, `registerWorkInProgress` and `workInProgress(forge)` in `src/content/wip.ts`. The default predicate is busy when an open `livespec` issue with label `livespec:phase/build` has a unit with `done === false`. Test: `default predicate is busy for a build change with a pending unit`.

- [ ] **Step 1:** Write `tests/content/compat.test.ts`: `Malformed front matter`, `Description too long`, `Name mismatch`, `Missing persona`, and `compatible tree passes`. Run; expect FAIL.
- [ ] **Step 2:** Implement `checkCompat`.
  - Front matter is the text between the first two `---` lines, parsed with `yaml.parse`.
  - Name rule: `/^[a-z0-9]+(-[a-z0-9]+)*$/`, length ≤ 64.
  - The description is 1 to 1024 characters.
  - Personas come from `personasForPack(pack)`. Each one must exist as `agents/<persona>.md`.

  Run; expect PASS.
- [ ] **Step 3:** Write `tests/content/upgrade.test.ts` as a table over `decideUpgrade`:
  - `Default channel`, `Notify channel`, `Pinned`, `Throttled`, `Build in progress`, `Skipped commit not reinstalled`;
  - `manual ignores the 24h limit`;
  - `manual refused while pinned`;
  - `manual refused during work in progress`.

  Run; expect FAIL. Implement it. Run; expect PASS.
- [ ] **Step 4:** Write `tests/content/manager.test.ts` against a bare upstream in a temp dir, with a temp `home` and an injected `now`:
  - `First clone`, `Clone fails` (bad URL), `Compatible upgrade`, `Incompatible upgrade`, `Failed check throttles too`;
  - `Manual update`, `Manual update refused in build`, `Rollback allowed in build`;
  - `Pin`, `Pin incompatible commit`, `Unpin`, `Rollback`, `Update while pinned`, `Status`;
  - `clone returns exists when current is present`;
  - `checkout leaves the mirror index untouched` (the mirror has no `index` file after `checkout`);
  - `keeps the last 5 trees`.

  Run; expect FAIL.
- [ ] **Step 5:** Implement `createMirror` and `ContentManager`.
  - **Mirror.** `git clone --mirror <source> mirror.git`, then `git --git-dir=mirror.git fetch --prune`. Head: `git --git-dir=mirror.git rev-parse HEAD`.
  - **Checkout.** `git --git-dir=mirror.git --work-tree=<dir> checkout -f <sha> -- .` through `GitExec` with `env: { GIT_INDEX_FILE: <tmp> }`. The temp index is deleted afterwards.
  - **First clone.** `clone(pack)` returns `exists` when `current` resolves. Otherwise it runs `ensure` and `fetch`, then installs head through the same staging path as an upgrade, so first clone also passes `checkCompat`.
  - **Install.** Staging, then `checkCompat`, then rename to `<sha>/`, then `symlink(<sha>, current.tmp)` and `rename(current.tmp, current)`, then the lock.
  - **Skill changes.** `SkillChanges` compares the sha-256 of each pack skill's `SKILL.md`.
  - **Failure.** On a failed check, delete the staging dir, update only `checkedAt` (automatic path), and keep the rest of the lock.

  Run; expect PASS.
- [ ] **Step 6:** Write `tests/content/expose.test.ts`:
  - `Initialized project`, `Uninitialized project`, `Excluded skills`, `No skills exposed` (invalid pack);
  - `exposed paths resolve to the sha tree, not current` (Review Focus 4).

  Run; expect FAIL. Implement `exposedSkillPaths` using `realpath(current)` (`activeTree`). Run; expect PASS.
- [ ] **Step 7:** Run `bun run test tests/content` and typecheck; expect PASS.
- [ ] **Step 8:** Commit `feat(content): agent-skills clone, upgrades and exposure`.

---

## Task 6: Init, doctor and skills commands — implements 6

**Covers:** 6.1, 6.2, 6.3
**Difficulty:** Hard
**Blocked by:** Task 4, Task 5

**Files:**
- Create: `src/commands/init.ts`, `src/commands/init-templates.ts`, `src/commands/doctor.ts`, `src/commands/doctor-checks.ts`, `src/commands/skills.ts`
- Test: `tests/commands/init.test.ts`, `tests/commands/doctor.test.ts`, `tests/commands/skills.test.ts`

**Interfaces:**
- Consumes: `ContentManager`, `checkCompat` and `WorkInProgress` (Task 5); `loadConfig` (Task 3); `LoadedPack` (Task 1); `runValidate` (`src/commands/validate.ts`); `detectForge` and `CachedForge` (LS-03).
- Consumes also: `TEMPLATE_MARKER` (Task 2).
- Produces: `runInit`, `runDoctor`, `DoctorDeps`, `DoctorResult`, `registerDoctorCheck`, `formatDoctor(results: DoctorResult[]): string`, and `runSkillsCommand(args: string, d: { content: ContentManager; pack: LoadedPack; channel: Channel; wip: () => Promise<WorkInProgress> }): Promise<string>`.

- [ ] **Step 1:** Write `tests/commands/init.test.ts`: `Fresh project`, `Idempotent`, `Clone failure`, `Templates validate`, and `rerun completes the clone`. Run; expect FAIL.
- [ ] **Step 2:** Implement `runInit`. It calls `content.clone(pack)` with the pack from `d.pack()`.
  - Templates live in `init-templates.ts` as constants.
  - `constraints.md` starts with `TEMPLATE_MARKER` from `src/core/templates.ts`.
  - `glossary.md` is `# Glossary\n`, with zero entries.
  - The config template holds commented examples of the project keys.

  Run; expect PASS.
- [ ] **Step 3:** Write `tests/commands/doctor.test.ts`. Each test uses fake `DoctorDeps`.
  - `Report only`: deps that throw if any write function is called, plus a snapshot of the temp dirs.
  - `Registered check`, `Duplicate skill`, `Missing pack skill`, `Superpowers in an untrusted project`, `Superpowers in a trusted project`.
  - `Forge read-only`, `OpenSpec folder`, `Clone state`, `No clone`, `Forge detection fails`, `Forge auth fails`, `Channel in project config`.

  Run; expect FAIL.
- [ ] **Step 4:** Implement one function per check in `doctor-checks.ts` and the runner in `doctor.ts`.
  - The Superpowers suggestion prints the probe (a) JSON snippet `{"packages":[{"source":"<superpowers source>","skills":[],"extensions":[]}]}`.

  Run; expect PASS.
- [ ] **Step 5:** Write `tests/commands/skills.test.ts`. It routes `status`, `update`, `pin <sha>`, `unpin` and `rollback` to the manager, and `unknown skills subcommand prints usage`. Run; expect FAIL. Implement it. Run; expect PASS.
- [ ] **Step 6:** Run `bun run test tests/commands` and typecheck; expect PASS.
- [ ] **Step 7:** Commit `feat(commands): init, doctor and skills`.

---

## Task 7: Context injection and resume — implements 7

**Covers:** 7.1, 7.2, 7.3, 7.4, 7.5
**Difficulty:** Hard
**Blocked by:** Task 4, Task 5

**Files:**
- Create: `src/hooks/routing-note.ts`, `src/hooks/phase-card.ts`, `src/hooks/session.ts`, `src/hooks/session-store.ts`, `src/hooks/card-input.ts`, `src/hooks/context.ts`, `src/hooks/skill-reads.ts`
- Test: `tests/hooks/routing-note.test.ts`, `tests/hooks/phase-card.test.ts`, `tests/hooks/session.test.ts`, `tests/hooks/context.test.ts`, `tests/hooks/fake-pi.ts`

**Interfaces:**
- Consumes: everything Task 4 produces; `ContentManager`, `exposedSkillPaths` and `workInProgress` (Task 5); `loadPack` (Task 1); `loadConfig` (Task 3); `TEMPLATE_MARKER` (Task 2).
- Produces:
  - `ROUTING_NOTE`, `CardInput`, `renderCard`, `registerCardSection`, `Session`, `getSession`, `setSession`;
  - `buildCardInput(d: { session: Session; first: boolean }): Promise<CardInput>`;
  - `registerContextHooks(pi: ExtensionAPI): void` and `registerSessionHooks(pi: ExtensionAPI, d?: Partial<SessionDeps>): void`.
  - `SessionDeps = { home: string; detect: typeof detectForge; content: (home: string) => ContentManager; now: () => Date }`.

- [ ] **Step 1:** Write `tests/hooks/routing-note.test.ts`: `Rules stated` and `Attribution`. Run; expect FAIL.
- [ ] **Step 2:** Write `ROUTING_NOTE` as a constant. It covers:
  - what livespec is;
  - "All forge writes and pushes go through livespec tools.";
  - "Updates from the integration branch are merges, never rebases.";
  - a five-bullet paraphrase of Core Operating Behaviors: surface assumptions, manage confusion, push back when warranted, simplicity, scope discipline;
  - the line `Core Operating Behaviors adapted from agent-skills by Addy Osmani (MIT License).`

  Run; expect PASS.
- [ ] **Step 3:** Write `tests/hooks/phase-card.test.ts` as snapshot plus targeted asserts:
  - `Card contents`, `Stale card`, `Registered section`, `Product pointer`;
  - `Template still present` and `Drafted` (constraints prompt);
  - `Reminder` (skill-note);
  - `pack errors card lists each error with file:line:col`;
  - `list card shows open changes with phases`.

  Run; expect FAIL.
- [ ] **Step 4:** Implement `renderCard` as a pure function.
  - The order is: header `livespec · #<n> <title> · <phase>`, Next, Required skills, Redirects, Blocking questions, Counters, Active units, Incomplete, Needs skill note, then the registered sections.
  - Forge strings are wrapped in `<untrusted>`.
  - Run; expect PASS.
- [ ] **Step 5:** Write `tests/hooks/fake-pi.ts`. It records `pi.on` handlers, `registerCommand`, `registerTool` and `sendMessage`, and exposes `fire(event, payload, ctx)`.
- [ ] **Step 6:** Write `tests/hooks/session.test.ts`:
  - `Resume mid-change`, `Other branch`, `Forge unavailable`, `Plain project`, `OpenSpec project`;
  - `Build complete` (auto-advance through `advancePhase`);
  - `Not blocking` (agent-skills-content). Inject a `ContentManager` whose `autoCheck` waits on a deferred promise. `fire("session_start")` must resolve while the promise is still pending.
  - `session exposes pack errors for an invalid override` (support for the `Tools refuse` test in Task 8);
  - `session_start kicks off autoCheck without awaiting it`.

  Run; expect FAIL.
- [ ] **Step 7:** Implement `Session`, `session-store`, `buildCardInput` and `registerSessionHooks`. Each `session_start` step is a separate function, so none of them grows into a god closure:
  - `loadSessionBasics`;
  - `connectForge` (`detectForge` → `new CachedForge(inner, { host, owner, repo })`);
  - `resolveAndSnapshot`;
  - `applyAdvance`;
  - `showResumeCard`;
  - `kickOffUpgrade`.

  Each step catches its own errors and records them on the session. Run; expect PASS.
- [ ] **Step 8:** Write `tests/hooks/context.test.ts`:
  - `Identical every turn`, `Appended at the end`, `Cache prefix stable over five turns`;
  - `Issue edited between prompts`;
  - `refresh rebuilds the card mid-run` (a unit test of `session.refresh()` alone; the scenario `After a write tool` is tested in Task 8 with the real tool);
  - `Initialized project` and `No skills exposed` via the `resources_discover` handler;
  - `context hook survives a throwing forge` (Review Focus 1);
  - `tool_call read of an optional SKILL.md is noted`.

  Run; expect FAIL.
- [ ] **Step 9:** Implement `registerContextHooks`:
  - **`before_agent_start`:** set `systemPromptOptions.sections.livespec = ROUTING_NOTE` when initialized, then `await session.refresh()`.
  - **`context`:** return `{ messages: [...event.messages, cardMessage] }`.
  - **`tool_call`:** observe `read` calls whose path ends in `/skills/<name>/SKILL.md` under the active tree, and add them to `skill-reads`.
  - **`resources_discover`:** return `{ skillPaths: exposedSkillPaths(...) }`.

  Run; expect PASS.
- [ ] **Step 10:** Run `bun run test tests/hooks` and typecheck; expect PASS.
- [ ] **Step 11:** Commit `feat(hooks): routing note, phase card and resume`.

---

## Task 8: Tools — implements 8

**Covers:** 8.1, 8.2, 8.3, 8.4
**Difficulty:** Hard
**Blocked by:** Task 4, Task 7

**Files:**
- Create: `src/tools/spec-status.ts`, `src/tools/spec-next.ts`, `src/tools/skill-note.ts`, `src/tools/spec-write.ts`, `src/tools/change-new.ts`, `src/tools/change-start.ts`, `src/tools/guard.ts`, `src/tools/format-step.ts`, `src/commands/next.ts`
- Test: `tests/tools/spec-status.test.ts`, `tests/tools/spec-write.test.ts`, `tests/tools/skill-note.test.ts`, `tests/tools/change-new.test.ts`, `tests/tools/change-start.test.ts`

**Interfaces:**
- Consumes: `getSession` and `Session.refresh` (Task 7); `nextStep`, `advancePhase`, `integrationBranch`, `Git` and `CommentsCache.invalidate` (Task 4); `sectionText`, `replaceSection`, `setHeaderLine` and `isKebabName` (Task 2); `parseChange` (LS-02).
- Produces:
  - `registerChangeTools(pi: ExtensionAPI): void`;
  - `afterForgeWrite(session, issue)` in `guard.ts`, called by `skill_note`, `spec_write`, `change_new` and `change_start` after a successful write;
  - `formatStep(step: NextStep, state: ChangeState): string`;
  - `runNextCommand(session: Session): Promise<string>`;
  - `requireWritable(session): { ok: true; forge: CachedForge } | { ok: false; message: string }` in `guard.ts`;
  - `requireValidPack(session)`, which returns the pack errors as a refusal.

- [ ] **Step 1:** Write `tests/tools/spec-status.test.ts`: `Status mid-change`, `Next command matches tool`, `No change`, and `Tools refuse` (invalid pack). Run; expect FAIL. Implement `spec_status`, `spec_next` and `/livespec next`. They share `formatStep` and call `session.refresh()` first. Run; expect PASS.
- [ ] **Step 2:** Write `tests/tools/skill-note.test.ts`: `Note posted`, `Not optional`, and `reason longer than 200 characters is refused`. Run; expect FAIL. Implement it; after posting, call `afterForgeWrite(session, n)`. Run; expect PASS.
- [ ] **Step 3:** Write `tests/tools/spec-write.test.ts`:
  - `Write proposal`, `Create missing section`, `Conflict` (the body is edited through the memory world between the read and the write);
  - `Invalid capabilities`, `Heading inside content`, `Unsupported section`, `Read-only`;
  - `capability names with bad hyphens are refused` (`-bad`, `bad--name`);
  - `After a write tool` (context-injection): run the real `spec_write` for `Proposal` through `fake-pi`, then fire `context`. The last card no longer says `Write Proposal with spec_write.`

  Run; expect FAIL.
- [ ] **Step 4:** Implement `spec_write`.
  - **Validate.** `Capabilities` must match `/^new \[(.*)\], modified \[(.*)\]$/`, and every comma-separated name in both lists must pass `isKebabName`. `Proposal` and `Design` must be non-empty with no line matching `/^## /`.
  - **Postconditions.** `parseChange` does not reject anything, so it is not used as a validator. Instead check:
    - `sectionText(newBody, section)` (or the header value) equals the trimmed content;
    - every line outside the section is unchanged;
    - for `Capabilities`, `parseChange(newBody).header.capabilities` deep-equals the parsed lists.
  - **Write.** `updateIssueBody(n, body, issue.version)`. A conflict is reported as `isError` with `changed`. On success, call `afterForgeWrite`.

  Run; expect PASS.
- [ ] **Step 5:** Write `tests/tools/change-new.test.ts`: `Create change` and `Duplicate name`. Run; expect FAIL. Implement it. The exact body template is:

  ```text
  Depends: —
  Capabilities: new [], modified []
  Product impact: —

  ## Proposal

  ## Design

  ## Questions

  ## Units

  ## Durable docs
  ```

  Run; expect PASS.
- [ ] **Step 6:** Write `tests/tools/change-start.test.ts`. Use a temp repo with a local bare `origin`, the memory forge, and a wrapper that injects write failures.
  - `Start change`, `No push` (the bare origin's refs are unchanged), `Dirty tree`, `Already started`;
  - `Config wins` (flow-engine): origin has `main` and `develop` at different commits and the config sets `integrationBranch: develop`. The new branch is at `origin/develop`'s commit and `Base` equals it.
  - `Write failure rolls back` (conflict), `Write lost in transit`, `Outcome unknown`, `Unreadable success response`.
  - `Server wrote before the failure`, `Server did not write`, `Mismatch`.
  - `Read-only`, and `local branch without livespecBase is refused`.

  Run; expect FAIL.
- [ ] **Step 7:** Implement `change_start`. Keep separate functions:
  - `validateStart`;
  - `createBranch` (fetch, revParse, switchCreate, configSet);
  - `recordStart` (setHeaderLine × 2, then write);
  - `handleWriteFailure` (conflict → rollback; thrown → re-read and compare);
  - `reconcileStart`.

  Never call `git push`. Run; expect PASS.
- [ ] **Step 8:** Run `bun run test tests/tools` and typecheck; expect PASS.
- [ ] **Step 9:** Commit `feat(tools): status, next, skill note, spec write and change tools`.

---

## Task 9: Extension wiring, docs and smoke — implements 9

**Covers:** 9.1, 9.2, 9.3, 9.4, 9.5
**Difficulty:** Normal
**Blocked by:** Task 6, Task 7, Task 8

**Files:**
- Modify: `src/extension.ts`, `tests/extension.test.ts`, `docs/architecture.md`
- Create: `tests/e2e-resume.test.ts`, `openspec/changes/engine-and-content/smoke.md`

**Interfaces:**
- Consumes: `registerSessionHooks`, `registerContextHooks` (Task 7), `registerChangeTools`, `runNextCommand` (Task 8), `runInit`, `runDoctor`, `formatDoctor`, `runSkillsCommand` (Task 6).
- Produces: the final `/livespec` router with the new `USAGE`.

- [ ] **Step 1:** Update `tests/extension.test.ts`:
  - `Usage lists subcommands`;
  - registered tools are exactly `spec_validate`, `spec_status`, `spec_next`, `skill_note`, `spec_write`, `change_new`, `change_start`;
  - registered events include `session_start`, `before_agent_start`, `context`, `tool_call` and `resources_discover`;
  - the existing version and validate tests stay green.

  Run; expect FAIL.
- [ ] **Step 2:** Write `tests/e2e-resume.test.ts` before wiring, so it is RED against the current `extension.ts`.
  - **Setup.**
    - A temp repo on branch `livespec/per-ip-cap` and an initialized config.
    - The memory forge, seeded with a copy of `tests/fixtures/change-body.md`. In the copy, Q1 is answered (`- [x] Q1 … — Answer: X-Forwarded-For`) and `Base:` is replaced by the temp repo's real HEAD SHA. Labels: `livespec` and `livespec:phase/build`. U1 is done and U3 is pending.
    - A pre-installed fake agent-skills tree.
  - **Run.** Fire `session_start`, then `before_agent_start`, then `context`, through `fake-pi` loaded with the real `extension` default export.
  - **Assert.** The resume message and the card name `#<n>`, `build` and `Build U3 — Rate limit per IP.` (Done when: "a new session opened mid-change shows the correct next step").
  - **Second test.** `unanswered blocking question wins on resume` uses the same fixture copy with the real `Base`, but keeps Q1 open. The card says `Answer blocking question Q1 before continuing.`

  Run; expect FAIL (the hooks are not wired yet).
- [ ] **Step 3:** Wire `src/extension.ts`.
  - Keep it a thin router: one `switch` on the subcommand, which delegates to the command modules.
  - Every handler body is one call.

  Run `tests/extension.test.ts` and `tests/e2e-resume.test.ts`; expect PASS.
- [ ] **Step 4:** Update `docs/architecture.md`:
  - the `engine/`, `content/` and `hooks/` rows;
  - the pack location `src/packs/agent-skills.yaml`;
  - the clone layout and the lock;
  - the routing note as a system prompt section and the card at the end.
- [ ] **Step 5 (parent, manual):** Run the 5-turn cache smoke, recorded in `openspec/changes/engine-and-content/smoke.md`.
  - **Setup.** pi with a scratch `PI_CODING_AGENT_DIR` and `defaultProjectTrust: "always"`. The extension is loaded with `-e`. The project is initialized and on a change branch.
  - **Runs.** A control run without the extension, and one with it. Each asks for six `ls` calls one at a time, through 9router, on two models.
  - **Record.** Log `turn_end.usage` and fill in the probe (c) table and the pass rule from `context-injection` / `Cache evidence`.
- [ ] **Step 6:** Run `bun run typecheck` and `bun run test`; expect PASS, with no skipped test.
- [ ] **Step 7:** Commit `feat: wire engine, content and tools into the extension` and `docs: architecture for engine and content`.

---

## Scenario → test

Each test is named exactly after its scenario.

**flow-pack**
- Default pack loads, Default pack contents, Spot check, Requires cycle, Replace one key, Replace a skills list, Add a phase, Merge loops, Error points at override, Unknown extends, Name changed, Standalone pack, Registered check name → `tests/engine/pack-load.test.ts`
- Wrong type, Wrong gate value, Unknown key, Model key rejected, YAML syntax error, Unregistered subagents, Registered sub-schema → `tests/engine/pack-schema.test.ts`
- Tools refuse → `tests/tools/spec-status.test.ts`
- No skills exposed → `tests/content/expose.test.ts` and `tests/hooks/context.test.ts`

**flow-engine**
- State from fixture issue, Stale state, Ambiguous phase → `tests/engine/snapshot.test.ts`
- Pure, No unit ready, Last phase, Blocking question first, Missing output, Not started, Next unit, Human gate ready, Build with pending units does not advance, Branching custom pack, Custom successor, Completed build with a human gate, Counter shown with cap → `tests/engine/next-step.test.ts`
- Units check in plan, Only active phase checks, Capabilities mismatch → `tests/engine/checks.test.ts`
- Counter update edits in place → `tests/engine/counters.test.ts`
- Comments cache hit, Account switch, Own write invalidates → `tests/engine/comments-cache.test.ts`
- Note posted, Not optional → `tests/tools/skill-note.test.ts`
- Reminder → `tests/hooks/phase-card.test.ts`
- Forward move, Skip refused, Partial failure, Normal move unaffected, Retry completes the move, Already moved, Three phase labels → `tests/engine/advance.test.ts`
- Build complete → `tests/hooks/session.test.ts`
- Default branch, Cannot resolve → `tests/engine/git.test.ts`
- Config wins → `tests/tools/change-start.test.ts`

**agent-skills-content**
- Not blocking → `tests/hooks/session.test.ts`
- First clone, Clone fails, Compatible upgrade, Incompatible upgrade, Failed check throttles too, Manual update, Unpin, Status, Pin, Pin incompatible commit, Update while pinned, Manual update refused in build, Rollback allowed in build, Rollback → `tests/content/manager.test.ts`
- Default channel → `tests/config.test.ts`
- Notify channel, Pinned, Throttled, Build in progress, Skipped commit not reinstalled → `tests/content/upgrade.test.ts`
- Malformed front matter, Description too long, Name mismatch, Missing persona → `tests/content/compat.test.ts`
- Initialized project, Uninitialized project, Excluded skills → `tests/content/expose.test.ts`

**init-and-doctor**
- Fresh project, Idempotent, Clone failure, Templates validate → `tests/commands/init.test.ts`
- Template still present, Drafted → `tests/hooks/phase-card.test.ts`
- Unknown key → `tests/config.test.ts`
- Report only, Registered check, Duplicate skill, Missing pack skill, Superpowers in an untrusted project, Superpowers in a trusted project, Forge read-only, OpenSpec folder, Clone state, No clone, Forge detection fails, Forge auth fails, Channel in project config → `tests/commands/doctor.test.ts`
- Usage lists subcommands → `tests/extension.test.ts`

**context-injection**
- Identical every turn, Appended at the end, Cache prefix stable over five turns, Issue edited between prompts → `tests/hooks/context.test.ts`
- After a write tool → `tests/tools/spec-write.test.ts`
- Rules stated, Attribution → `tests/hooks/routing-note.test.ts`
- Card contents, Stale card, Registered section, Product pointer → `tests/hooks/phase-card.test.ts`
- Smoke recorded → `openspec/changes/engine-and-content/smoke.md`, a manual record checked by `/opsx-verify`
- Resume mid-change, Other branch, Forge unavailable, Plain project, OpenSpec project → `tests/hooks/session.test.ts`; Resume mid-change is also in `tests/e2e-resume.test.ts`

**change-tools**
- Status mid-change, Next command matches tool, No change → `tests/tools/spec-status.test.ts`
- Write proposal, Create missing section, Conflict, Invalid capabilities, Heading inside content, Unsupported section → `tests/tools/spec-write.test.ts`
- Create change, Duplicate name → `tests/tools/change-new.test.ts`
- Start change, No push, Dirty tree, Already started, Write failure rolls back, Write lost in transit, Outcome unknown, Unreadable success response, Server wrote before the failure, Server did not write, Mismatch, Read-only → `tests/tools/change-start.test.ts`
