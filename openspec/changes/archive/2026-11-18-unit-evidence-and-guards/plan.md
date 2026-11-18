# Unit Evidence and Guards Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Only the parent session's tools can prove a unit and tick it: red before, green after, receipts on the issue, capped retries. A `tool_call` guard blocks direct forge writes, pushes and edits of `.pi/livespec/` by the agent inside pi.

**Architecture:**
- **Pure deciders.** `src/guard/` (shell parsing, classification, paths) and `src/evidence/` (records, derived unit state, red/green, pending, signature, the `progress` rule, refusals) hold every rule as a pure function, tested by tables.
- **Thin I/O.** The I/O sits in a few small modules: the `Verify` runner, temporary worktrees, the red-on-base check, the work-in-progress predicate, and `guardedPush`.
- **Thin tools and hooks.** Two tools (`unit_start`, `unit_finish`) and two hooks (`tool_call` guard, `agent_before_settle`) run under a lock: they load state, call a decider and write.
- **Forge as the only state.** Evidence lives only on the forge as own marked comments (design D2): `unit-start`, `receipt`, `progress` decision records and `incomplete`. Every view (card, next step, work-in-progress, settle) derives from the same `deriveUnitEvidence`.

**Tech Stack:** TypeScript (ESM, `.ts` imports, `strict`), `yaml` (the only runtime dependency), the `git` executable, `/bin/sh`, `node:child_process` (`spawn` with `detached` for process-group kill), `node:crypto`, vitest, bun, and pi `ExtensionAPI` (`tool_call`, `agent_before_settle`, `agent_settled`, `session_shutdown`).

**Spec:** `openspec/changes/unit-evidence-and-guards/specs/`, with 3 new, 1 ADDED-only and 6 modified capabilities, and `design.md` (D1–D16). The user decisions and accepted limits are in `brainstorm.md`.

## Global Constraints

- **Dependencies.** `dependencies` stays exactly `{ "yaml": ... }`. No new runtime or dev dependency.
- **Commands.** Use `bun` only: `bun run test` and `bun run typecheck`. CI runs exactly these two.
- **Language.** All code, comments, docs and commit messages are in English.
- **Tests.**
  - No network calls: the forge is `MemoryWorld` (`tests/forge/memory-forge.ts`), and git repositories are temporary (`tests/helpers/repo.ts`, `tests/tools/helpers.ts` `toolHarness`).
  - Each scenario test is named exactly after its `#### Scenario:` title.
- **Safety.**
  - Tests never push to a real remote, and never edit pi settings or the user's git config.
  - The only `git push` in `src/` is in `src/guard/push.ts`, and no file under `src/tools/` imports it.
- **Tool parameters.** No tool takes a parameter for an outcome, a verdict, a pending flag, an attempt count or an exit code. `unit_start` and `unit_finish` take only `{ unit: string }`.
- **Own comments.** Only own marked comments are state (`filterMarked`).
- **Untrusted text.** Forge text and `Verify` output shown to the model are wrapped with `untrusted()` (`src/hooks/phase-card.ts`).
- **Redaction.** Known tokens are redacted from captured output inside the runner, before any caller sees it (`redactTokens`, `src/accounts/redact.ts`).
- **Body edits.** The tick keeps every other byte, with line endings included (`tickUnit`, `src/core/tick.ts`).
- **Hooks.** A livespec hook never throws into pi. The guard fails closed: an internal error blocks the call. The settle hook fails open: an internal error is recorded and the agent settles.
- **Constants.** These values are fixed:
  - `RECEIPT_OUTPUT_BYTES = 8192`, including the truncation mark;
  - `PROGRESS_OUTPUT_BYTES = 2048`;
  - `DEFAULT_VERIFY_TIMEOUT_S = 600`;
  - `KILL_GRACE_MS = 5000`;
  - `UNWRAP_DEPTH = 8`.
- **Checkpoints.** Every task ends with `bun run test` and `bun run typecheck` both passing on the task branch, with only its blockers merged.
- **Commits.** Stage the files the task lists explicitly before committing.
- **Coding standards.** Follow `~/.agents/skills/coding-standards/SKILL.md`. Each module has one responsibility. Tools and hooks stay thin over pure deciders: no god function, and no closure that holds several responsibilities.

## Review Focus

1. **Guard bypass forms that the table does not list.** A person expects these to be blocked:
   - `git --no-pager push`;
   - `GIT_DIR=x git push`;
   - `cd sub && git push`;
   - `\git push`;
   - `"git" "push"`;
   - `/usr/bin/git push`;
   - `gh --repo o/r issue edit 6`;
   - `cd .pi && echo x > livespec/flow.yaml`.

   Test in Task 1: `push and gh variants beyond the spec list are blocked`.
2. **Guard false positives on everyday commands.** These must all be allowed:
   - `grep -r push src/`;
   - `git log --grep=push`;
   - `echo "gh is installed"`;
   - `rg tea`;
   - `bun test`;
   - `git stash push -m x`;
   - `cd src && echo x > out.txt`.

   Test in Task 1: `everyday commands mentioning push, gh or tea are allowed`.
3. **`Verify` output edge cases.** These must give a receipt of at most 8192 bytes and never throw:
   - binary or invalid UTF-8 bytes;
   - CRLF output;
   - a multibyte character exactly at the cut;
   - an empty output;
   - 20 KB of output.

   Tests in Task 3: `output tail handles binary, CRLF, multibyte cut and empty output` and `runner output over the budget carries the truncation mark`.
4. **`unit_finish` called twice at once, or after a partial failure.** These must never post two receipts or tick twice:
   - two `unit_finish` calls (parallel tool calls);
   - a forge conflict on the tick;
   - a transport error on the tick.

   Tests in Task 5: `parallel unit_finish posts one receipt and one tick` and `tick conflict re-reads once`.
5. **Temporary worktrees or processes left behind.** No `livespec-verify-*` worktree and no `Verify` process may remain, and `git worktree list` must be back to one entry, when:
   - `Verify` throws;
   - `Verify` times out;
   - setup fails;
   - the session shuts down mid-run.

   Tests in Task 3: `temporary worktree is removed after error, timeout and failed setup` and `abort kills the run and removes the worktree`.

---

## Contracts

Ownership: the task that creates a module owns its types. A type that another task needs before the merge is defined where no cross-task import is needed: `runVerify` takes a plain `(cmd: string) => string | undefined` guard instead of importing `GuardDecision`.

| Name | new / modified | Shape | public |
|---|---|---|---|
| Tool `unit_start` | new | params `{ unit: string }` | yes |
| Tool `unit_finish` | new | params `{ unit: string }` | yes |
| Marker kind `unit-start` | new | id `U<n>.<base36 ms>`; yaml `StartData = { unit: string; digest: string; verify: string; pre: { sha: string; exit?: number; verdict?: "red" \| "green"; output?: string }; pending?: true; refactor?: true }` | yes |
| Marker `receipt` data | new use of a core kind | id `U<n>.<base36 ms>`; yaml `ReceiptData = { unit: string; digest: string; verify: string; pre: { sha: string; exit: number }; post: { sha: string; exit: number }; output: string; start: string; pending_commit?: string }`, where `start` is the `unit-start` marker id | yes |
| Marker `incomplete` data | new use of a core kind | id `<change number>`; yaml `{ items: string[]; at: string; head_sha: string }`; an empty `items` means cleared | yes |
| `DecisionRecord` | modified | adds `signature?: Signature` and `attempt?: number`; `compactFacts` keeps both when `facts` becomes `facts_hash` | yes |
| `progress` record | new | `progressRecord(i: { unit: string; digest: string; start: string; attempt: number; exit: number \| null; postSha: string; signature: Signature; outputTail: string; decided: Decided }): DecisionRecord`, giving `{ point: "progress", subject: unit, digest, source: "rule", outcome: "retry" \| "stop", reason, attempt, signature, facts: { start, attempt, exit, post_sha, signature, output_tail } }` with `output_tail` ≤ `PROGRESS_OUTPUT_BYTES`, in `src/evidence/progress-rule.ts` | yes |
| `progress` rule | new | point `progress`; facts `ProgressFacts = { attempt: number; cap: number; signature: Signature; previous?: Signature }`; outcome `"retry" \| "stop"`; config `decisions.progress: { mode: rule }`; `previousSignature(marked: MarkedComment[], unit: string, sinceIndex: number): Signature \| undefined` reads the record's `signature` field | yes |
| `Signature` | new | `{ tests: string[]; hash: string }`; `failureSignature(output: string): Signature` in `src/evidence/signature.ts` | no |
| `StartRecord` / `ReceiptRecord` | new | `StartData & { id: string; commentId: string; index: number }` and `ReceiptData & { id: string; commentId: string; index: number }`, where `index` is the comment order; `startComment(id: string, d: StartData): string`, `receiptComment(id: string, d: ReceiptData): string`, `newEvidenceId(unit: string, now: Date): string`, `readStarts(marked): StartRecord[]`, `readReceipts(marked): ReceiptRecord[]` in `src/evidence/records.ts` | no |
| `UnitEvidence` | new | `{ started: Record<string, StartRecord>; receipts: Record<string, ReceiptRecord[]>; attempts: Record<string, number>; blocked: Record<string, "attempts" \| "progress">; untickedReceipts: string[] }`; `deriveUnitEvidence(change: Change, marked: MarkedComment[], cap: number \| undefined): UnitEvidence` in `src/evidence/unit-state.ts` | no |
| `liftsCap` | modified (exported) | `liftsCap(m: MarkedComment): boolean` from `src/engine/iterations.ts` | no |
| `isTestFile` / `pendingDecision` / `testOnlyCommitCheck` | new | `isTestFile(path: string): boolean`; `pendingDecision(u: Unit, exists: (path: string) => boolean): boolean`; `testOnlyCommitCheck(u: Unit, changed: string[]): { ok: true } \| { ok: false; extra: string[] }` in `src/evidence/pending.ts` | no |
| `outputTail` | new | `outputTail(tail: Buffer, totalBytes: number, maxBytes: number): string` in `src/evidence/output.ts`. It decodes with replacement characters and cuts on a UTF-8 boundary. When `totalBytes > maxBytes`, it prefixes `…[truncated N bytes]\n`, keeping the whole result ≤ `maxBytes` | no |
| `StreamRedactor` | new | `class StreamRedactor { constructor(tokens: string[]); push(chunk: Buffer): Buffer; end(): Buffer }` in `src/evidence/output.ts`. It redacts across chunk boundaries by holding back `maxTokenLength - 1` bytes; the runner's ring buffer only receives redacted bytes | no |
| `VerifyRun` | new | `{ exit: number \| null; timedOut: boolean; aborted: boolean; spawnError?: string; output: string; totalBytes: number }` in `src/evidence/runner.ts` | no |
| `RunOptions` | new | `{ cwd: string; timeoutS: number; guard: (cmd: string) => string \| undefined; tokens: string[]; tailBytes: number; signal?: AbortSignal }`, where `guard` returns a block reason or `undefined` | no |
| `runVerify` | new | `runVerify(command: string, o: RunOptions): Promise<VerifyRun \| { blocked: string }>`; it never spawns a blocked command | no |
| `RunClass` | new | `"red" \| "green" \| { invalid: "not-runnable" \| "timeout" \| "spawn" \| "setup" \| "aborted" }`; `classifyRun(r: VerifyRun): RunClass`, `preExpectation(u: Unit): "red" \| "green"`, `postOk(c: RunClass): boolean` in `src/evidence/red-green.ts` | no |
| `withTempWorktree` | new | `withTempWorktree<T>(git: Git, root: string, sha: string, prep: { setup?: string; run: Omit<RunOptions, "cwd"> }, fn: (dir: string) => Promise<T>): Promise<T \| { invalid: "setup" \| "aborted"; output: string }>` in `src/evidence/worktree.ts`; it prunes first and always removes | no |
| `Git` | modified | adds `worktreeAdd(dir: string, sha: string): Promise<void>` (`worktree add --detach`); `worktreeRemove(dir: string): Promise<void>` (`worktree remove --force`); `worktreePrune(): Promise<void>`; `revList(range: string): Promise<string[]>` (`rev-list --reverse`); `pathExistsAt(sha: string, path: string): Promise<boolean>` (`cat-file -e`); `changedPaths(commit: string): Promise<string[]>` (`diff-tree --no-commit-id --name-only -r --root`); `isIgnored(path: string): Promise<boolean>` (`check-ignore -q`); `aliases(): Promise<Record<string, string>>` (`config --get-regexp ^alias\.`, an empty map on exit 1) | no |
| `ProjectConfig.verify` | new | `verify?: { setup?: string; timeoutS: number }` from yaml `verify: { setup: string, timeout: number }`; `timeoutS` defaults to 600; warnings for a non-string setup and a non-positive or non-integer timeout | yes |
| `deriveCommentFacts` | modified | `deriveCommentFacts(marked, change, caps: { iterations: number \| undefined; unitAttempts: number \| undefined })`. Callers: `snapshot.ts`, `src/interaction/complete-validate.ts` | no |
| `SnapshotDeps` | modified | replaces `iterationCap?: number` with `caps?: { iterations?: number; unitAttempts?: number }`. Callers: `src/hooks/card-input.ts`, `tests/engine/*.test.ts` | no |
| `ChangeState` | modified | adds `evidence: UnitEvidence`; `issue` gains `url?: string`; `incomplete: string[]` now holds the items of the latest own `incomplete` comment (empty when cleared or absent); `counters` gains `unit_attempts.<U>` from `evidence.attempts`; `readCounters` ignores `counter` comments whose id starts with `unit_attempts.` | yes |
| `NextStep` | modified | renames `blockedUnits` → `waitingUnits: { id: string; waitingOn: string[] }[]`; adds `startedUnits: string[]`, `blockedUnits: { id: string; reason: "attempts" \| "progress" }[]`, `untickedReceipts: string[]`, `pendingVerifier: string[]` (started units whose `unit-start` has `pending: true`) | yes |
| `registerCheck` | modified | `registerCheck(name, fn, opts?: { waivable?: boolean; at?: "gate"; key?: (ctx: CheckContext) => string })`; `isGateOnly(name): boolean`; `CheckContext` is unchanged | yes |
| `runChecks` | modified | `runChecks(pack, state, ctx, opts?: { gate?: boolean; target?: string })`. With `gate`, the gate-only checks of the phase or named gate `target` run, and `{ key: key(checkCtx), results }` is stored in a module-level `Map<string, { key: string; results: Result[] }>` in `src/engine/registry.ts`. Without `gate`, the stored results are returned when the key matches, else none. `clearGateMemo(): void` empties it, increments `gateMemoGeneration(): number`, and calls every callback registered with `onGateMemoClear(fn: () => void): void`. `resetRegistryForTests` does the same | yes |
| `GuardDecision` / `GuardContext` | new | `{ allow: true } \| { allow: false; rule: string; reason: string }`; `{ cwd: string; endpoints: string[]; aliases: Record<string, string> \| "unknown" }` in `src/guard/classify.ts` | no |
| `classifyCommand` | new | `classifyCommand(command: string, ctx: GuardContext): GuardDecision`; pure | yes |
| `forgeEndpoints` | new | `forgeEndpoints(target: { kind: ForgeKind; host: string; authority?: string } \| undefined, config: ProjectConfig \| null): string[]` | no |
| `ShellCommand` | new | `{ words: Word[]; assignments: string[]; redirects: { op: string; target: Word }[]; substitutions: string[] }`, where `Word = { text: string; quoted: boolean; expansion: boolean }`; `parseShell(text: string): ShellCommand[] \| "unreadable"` in `src/guard/shell.ts`, in source order | no |
| `protectedWrite` / `isLivespecPath` | new | `isLivespecPath(cwd: string, path: string): boolean`; `protectedWrite(commands: ShellCommand[], cwd: string): string \| undefined` (the first protected target, tracking `cd`/`pushd` per command-guards "Livespec project files") in `src/guard/paths.ts` | no |
| `guardedPush` | new | `guardedPush(exec: GitExec, root: string, remote: string, refspec: string): Promise<void>` in `src/guard/push.ts`; not called in LS-06 | no |
| `VerifyEnv` | new | `{ root: string; git: Git; config: ProjectConfig \| null; run: Omit<RunOptions, "cwd" \| "tailBytes"> }`; `verifyEnv(session: Session, signal?: AbortSignal): Promise<VerifyEnv>` in `src/evidence/verify-env.ts`. It reads aliases once per call and builds `guard` from `classifyCommand` | no |
| `Session` | modified | adds `redactionTokens(): string[]` (the list the `RedactingForge` uses, kept on the session by `connect`), `forgeTarget(): ForgeTarget \| undefined`, `shutdownSignal: AbortSignal` (aborted by `session_shutdown`), and `drainEvidence(): Promise<void>` (awaits `withEvidenceLock`'s chains) | no |
| `withEvidenceLock` | new | `withEvidenceLock<T>(issue: number, fn: () => Promise<T>): Promise<T>` in `src/evidence/lock.ts`, a per-process promise chain keyed by issue | no |
| `unitStartRefusal` / `unitFinishRefusal` / `finishMode` | new | `unitStartRefusal(state: ChangeState, pack: Pack, unit: string): string \| undefined`; `finishMode(state: ChangeState, unit: string): "reconcile" \| "run"`; `unitFinishRefusal(state: ChangeState, pack: Pack, unit: string, mode: "reconcile" \| "run"): string \| undefined` in `src/evidence/refusals.ts` | no |
| `setRedOnBaseEnv` | new | `setRedOnBaseEnv(provider: () => Promise<VerifyEnv \| undefined>): void` in `src/evidence/red-on-base.ts`; set by `src/extension.ts` from `getSession()` | no |
| `registerSettleCondition` | new | `registerSettleCondition(name: string, fn: (state: ChangeState) => string \| undefined): void`; `resetSettleConditionsForTests()` in `src/hooks/settle.ts` | yes |
| Pack | modified | `plan.checks: [units-format, done-maps-scenarios, unit-classification, verify-red-on-base]`; `decisions.progress: { mode: rule }`; fixture `tests/fixtures/agent-skills.pack.json` updated (Task 6) | yes |

---

## Task 1: Shell parser and command guard classifier — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4, 1.5
**Difficulty:** Very Hard
**Blocked by:** none

**Files:**
- Create: `src/guard/shell.ts`, `src/guard/classify.ts`, `src/guard/paths.ts`
- Test: `tests/guard/shell.test.ts`, `tests/guard/classify.test.ts`, `tests/guard/paths.test.ts`

**Interfaces:**
- Produces: `parseShell`, `ShellCommand`, `classifyCommand`, `GuardContext`, `GuardDecision`, `forgeEndpoints`, `isLivespecPath`, `protectedWrite`.
- Consumes: `ForgeKind` (`src/forge/types.ts`) and `ProjectConfig` (`src/config.ts`), as types only.

- [ ] **Step 1: Write failing parser tests in `tests/guard/shell.test.ts`.**
  - `parses chains, pipes, subshells and redirects`: `a && b | c; (d) > out` gives 4 commands in order, and `out` is d's redirect target.
  - `echo "x" 'y' \z` gives the words `echo x y z`.
  - `$(git push)` and `` `git push` `` appear in `substitutions`.
  - `unbalanced quotes are unreadable`: `echo "x` → `"unreadable"`.
- [ ] **Step 2:** Run `bun run test tests/guard/shell.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `parseShell` in `src/guard/shell.ts`.** It is a hand-written character state machine:
  - quotes, `\`-escapes and `#` comments are handled first;
  - `;`, `&&`, `||`, `|`, `&` and newline split commands;
  - `( )` and `{ }` bodies are flattened in source order;
  - `<`, `>`, `>>` and `2>` capture their target word;
  - `$(…)` and backticks are kept as raw text in `substitutions`;
  - a word is `expansion: true` when it has an unquoted `$` or a substitution.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Write failing classifier tests in `tests/guard/classify.test.ts`.**
  - **Scenario tests.** One `it` per command-guards classification scenario, named exactly after it: `Reason names the tool`, `Manual tick blocked`, `Self-approval comment blocked`, `API write blocked, read allowed`, `Raw HTTP write to the forge host`, `GitHub API host`, `Tea write blocked`, `Push variants blocked`, `Push alias blocked`, `Pull request commands blocked`, `Ordinary git allowed`, `Eval blocked`, `Variable git subcommand`, `Variable command word`, `Harmless eval allowed`, `Script file allowed`, `Shell write blocked`, `Directory change before the write` and `Read allowed`. Each uses the scenario's exact commands, with `endpoints` from `forgeEndpoints({ kind: "github", host: "github.com" }, null)`, or from a Gitea target `git.example.com`, and with `aliases: { p: "push" }` where needed.
  - **`push and gh variants beyond the spec list are blocked`:** every command in Review Focus 1.
  - **`everyday commands mentioning push, gh or tea are allowed`:** every command in Review Focus 2.
  - **Reasons.** Every block reason matches `/^livespec guard: /`. `gh issue edit` names `spec_write`, and `gh issue comment` names `spec_question` or `spec_gate`. The push reason names livespec tools and LS-09.
- [ ] **Step 6:** Run `bun run test tests/guard/classify.test.ts`. Expected: FAIL.
- [ ] **Step 7: Implement `forgeEndpoints` and `classifyCommand` in `src/guard/classify.ts`.**
  - **Unwrapping** (design D7), up to `UNWRAP_DEPTH`:
    - The command word is compared by its basename, with a leading `\` stripped.
    - `sh|bash|zsh|dash -c` scripts and substitutions are reparsed.
    - `git` global options are skipped: `-C`, `-c`, `--git-dir[=]`, `--work-tree[=]`, `--no-pager`, `-p`, `--bare`, `--namespace[=]`.
    - `gh` global options are skipped: `--repo`/`-R`.
    - The subcommand is resolved through `ctx.aliases`.
  - **Rules** are table-driven: an array of `{ id, matches(cmd, ctx), reason }`, following the design D7 table and the command-guards endpoint rule.
  - **Obscured forms** follow command-guards "Obscured commands".
  - **Write targets** are delegated to `protectedWrite` (Step 10).
- [ ] **Step 8:** Run the classifier tests, except the path scenarios. Expected: PASS.
- [ ] **Step 9: Write failing path tests in `tests/guard/paths.test.ts`.**
  - `isLivespecPath` is true for `.pi/livespec/flow.yaml`, `./.pi/livespec/x`, `src/../.pi/livespec/config.yaml`, an absolute path under the folder, and `link/flow.yaml` through a temporary symlink `link -> .pi/livespec`.
  - `isLivespecPath` is false for `.pi/livespecx/a` and `docs/.pi/livespec/a`.
  - `Path traversal` (pure part): `src/../.pi/livespec/config.yaml` is true.
  - `protectedWrite` covers the `Directory change before the write` cases and their allowed counterpart.
- [ ] **Step 10: Implement `isLivespecPath` and `protectedWrite` in `src/guard/paths.ts`.**
  - The candidate-directory set follows design D7 "Working directory inside one command".
  - The write commands are redirects, `tee`, `cp`, `mv`, `rm`, `ln`, `touch`, `install`, `sed -i` and `perl -i`.
  - `realpathSync` is applied to the deepest existing parent.

  Wire `protectedWrite` into `classifyCommand`. Run `bun run test tests/guard`. Expected: PASS.
- [ ] **Step 11:** Run `bun run test && bun run typecheck`. Expected: both exit 0.
- [ ] **Step 12: Commit.** `git add src/guard tests/guard && git commit -m "feat(guard): classify shell commands for forge writes, pushes and livespec files"`

---

## Task 2: Evidence records, unit state and the progress rule — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Create: `src/evidence/records.ts`, `src/evidence/signature.ts`, `src/evidence/progress-rule.ts`, `src/evidence/unit-state.ts`, `src/evidence/pending.ts`
- Modify: `src/decide/records.ts` (`signature` and `attempt` fields, `compactFacts`, `optionalFieldsValid`), `src/decide/registry.ts` (`registerBuiltinRules` adds `progress`), `src/engine/iterations.ts` (export `liftsCap`)
- Test: `tests/evidence/records.test.ts`, `tests/evidence/signature.test.ts`, `tests/evidence/progress-rule.test.ts`, `tests/evidence/unit-state.test.ts`, `tests/evidence/pending.test.ts`

**Interfaces:**
- Produces: `StartData`, `ReceiptData`, `StartRecord`, `ReceiptRecord`, `startComment`, `receiptComment`, `newEvidenceId`, `readStarts`, `readReceipts`, `Signature`, `failureSignature`, the `progress` rule, `progressRecord`, `previousSignature`, `UnitEvidence`, `deriveUnitEvidence`, `isTestFile`, `pendingDecision` and `testOnlyCommitCheck`.
- Consumes: `writeMarked`, `registerKind`, `MarkedComment` (`src/forge/markers.ts`); `decisionComment`, `DecisionRecord` (`src/decide/records.ts`); `registerRule`, `checkAllowedKeys` (`src/decide/registry.ts`, `src/decide/rules/schema-util.ts`); `Decided` (`src/decide/seam.ts`); `matchGlob` (`src/core/glob.ts`).

- [ ] **Step 1: Write failing tests.**
  - **`records.test.ts`:**
    - `unit-start round trip`: `startComment(id, d)` parsed back through `parseMarked` gives `d`;
    - `receipt round trip`;
    - `newEvidenceId("U1", now)` matches `/^U1\.[0-9a-z]+$/`.
  - **`signature.test.ts`:**
    - vitest `FAIL tests/a.test.ts > adds` → `["tests/a.test.ts > adds"]`;
    - `--- FAIL: TestX` → `["TestX"]`;
    - `FAILED tests/test_a.py::test_b` → `["tests/test_a.py::test_b"]`;
    - `not ok 3 - parses` → `["parses"]`;
    - two outputs that differ only in `12ms`/`40ms`, `/tmp/abc/x`/`/tmp/def/x`, an ISO timestamp, a 40-hex SHA and ANSI codes have equal hashes;
    - a changed assertion message gives a different hash.
  - **`progress-rule.test.ts`** (decision-seam): `Two identical failures stop early`, `Different failures retry`, `Cap with different failures` and `Unrecognized output`, through `decide("progress", facts, …)`.
  - **`Large output keeps the signature`.** Build `progressRecord` with facts over 2,000 yaml characters and pass it through `decisionComment` and `parseMarked`. The parsed record has `facts_hash`, `signature` and `attempt`. Feed it to `previousSignature`, then run the rule with an equal signature: the outcome is `stop`.
  - **`progressRecord` caps the output.** `output_tail` is at most 2048 bytes.
  - **`pending.test.ts`:**
    - `isTestFile` matches the six patterns;
    - `pendingDecision` is true when a listed test file is missing, and false when all exist or when `Files` has no test file;
    - `testOnlyCommitCheck` names `src/limit.ts` as extra.
  - **`unit-state.test.ts`:**
    - `Started unit from comments` and `Done unit is never started` (flow-engine);
    - `Derived unit attempts`: a `counter` comment `unit_attempts.U2` with value 9 is ignored, and the result is 2;
    - attempts reset after a receipt and after a lifting stuck answer;
    - `Dismissed stuck answer keeps the block` and `Chosen stuck answer restarts the budget`;
    - blocked `attempts` at the cap, and blocked `progress` on a `stop` record;
    - `untickedReceipts` when the receipt is newer than the start, the digest matches and the unit is pending.
- [ ] **Step 2:** Run `bun run test tests/evidence`. Expected: FAIL.
- [ ] **Step 3: Implement the modules with the Contracts signatures.**
  - `records.ts` calls `registerKind("unit-start")` at import.
  - `deriveUnitEvidence` walks `marked` once in comment order. Per unit, it tracks the latest start, receipt, lifting stuck answer and `progress` record indexes. Every `progress.U` record in the window counts as an attempt.
  - `registerBuiltinRules` registers `progressRule` with `progressSchema` (`mode` only).
- [ ] **Step 4:** Run `bun run test tests/evidence tests/decide`. Expected: PASS.
- [ ] **Step 5:** Run `bun run test && bun run typecheck`. Expected: both exit 0.
- [ ] **Step 6: Commit.** `git add src/evidence src/decide/records.ts src/decide/registry.ts src/engine/iterations.ts tests/evidence && git commit -m "feat(evidence): records, derived unit state and the progress rule"`

---

## Task 3: Verify runner, temporary worktrees, run classification, Git additions and config — implements 3

**Covers:** 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Create: `src/evidence/output.ts`, `src/evidence/runner.ts`, `src/evidence/red-green.ts`, `src/evidence/worktree.ts`
- Modify: `src/config.ts` (`verify` in `PROJECT_KEYS`, `readVerify`), `src/engine/git.ts` (Contracts `Git` additions)
- Test: `tests/evidence/output.test.ts`, `tests/evidence/runner.test.ts`, `tests/evidence/red-green.test.ts`, `tests/evidence/worktree.test.ts`, `tests/engine/git.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces: `outputTail`, `VerifyRun`, `RunOptions`, `runVerify`, `RunClass`, `classifyRun`, `preExpectation`, `postOk`, `withTempWorktree`, the `Git` additions, and `ProjectConfig.verify`.
- Consumes: `redactTokens` (`src/accounts/redact.ts`) and `Unit` (`src/core/change.ts`). No module from Tasks 1 or 2: the guard is injected as a plain function.

- [ ] **Step 1: Write failing tests.**
  - **`output.test.ts`:**
    - `token split across chunks is redacted`: `StreamRedactor(["s3cr3t"])` given `"xx s3"`, then `"cr3t yy"` emits no `s3cr3t` and no `s3`/`cr3t` fragment of it;
    - `token at the tail boundary is redacted`: a 20 KB output whose token starts 3 bytes before the retained 8 KB yields a tail with no token fragment;
    - `Output tail`: a 20 KB buffer with `totalBytes` 20480 → at most 8192 bytes, starting `…[truncated `;
    - `output tail handles binary, CRLF, multibyte cut and empty output`: invalid bytes become `U+FFFD`, `\r\n` is kept, an `é` straddling the cut is not split, and an empty buffer gives `""`.
  - **`config.test.ts`:** `Verify settings` and `Invalid verify timeout` (init-and-doctor), and a non-string `setup` warns.
  - **`git.test.ts`:** each new `Git` method against a temporary repository; `aliases()` without aliases is `{}`.
  - **`red-green.test.ts`:**
    - exit 0 → green; exit 1 → red;
    - 126, 127, `spawnError`, `timedOut` and `aborted` → the matching `invalid`;
    - a refactor unit's `preExpectation` is green.
  - **`runner.test.ts`:**
    - `Command not found is not red`: `nosuchtool-xyz` → `exit: 127`;
    - `Timeout`: `timeoutS: 1` with `sleep 5; echo done` → `timedOut: true` within 7 s, and `pgrep -f "sleep 5"` finds nothing;
    - `Blocked Verify is never run` (runner part): a `guard` returning a reason → `{ blocked }`, and a marker file the command would create does not exist;
    - a token in `tokens` is redacted;
    - `cat` returns immediately because stdin is closed;
    - `runner output over the budget carries the truncation mark`: `head -c 20000 /dev/urandom | base64` → `output` ≤ 8192 bytes, with the mark and `totalBytes` > 8192;
    - `abort kills the run and removes the worktree` (runner part): aborting the signal mid-`sleep 30` returns `aborted: true` and leaves no process.
  - **`worktree.test.ts`:**
    - `Dependencies linked`: an ignored `node_modules` in the main repo is a symlink inside `dir` during `fn`, and `dir` is gone afterwards;
    - `temporary worktree is removed after error, timeout and failed setup`: when `fn` throws, when setup is `exit 3` (→ `{ invalid: "setup" }`) and on a timeout, `git worktree list` has one line afterwards and no `livespec-verify-*` directory remains;
    - `abort kills the run and removes the worktree`: an abort during `fn` gives the same cleanup.
- [ ] **Step 2:** Run `bun run test tests/evidence tests/engine/git.test.ts tests/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`runVerify`:**
    - call `guard` first;
    - `spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] })`;
    - on timeout or abort, `process.kill(-pid, "SIGTERM")`, then `SIGKILL` after `KILL_GRACE_MS`;
    - pass every stdout/stderr chunk through one `StreamRedactor(tokens)` before it enters a ring `Buffer` of the last `tailBytes` bytes, counting `totalBytes`;
    - finish with `outputTail(ring, totalBytes, tailBytes)`. Redaction happens before the cut, never after;
    - with a signal that is already aborted, return `aborted: true` without spawning.
  - **`withTempWorktree`:**
    1. `worktreePrune`, then `mkdtemp(join(tmpdir(), "livespec-verify-"))` and `worktreeAdd`;
    2. run setup through `runVerify`, or create the symlinks for each ignored dependency folder;
    3. run `fn`;
    4. in `finally`, `worktreeRemove` and `rm -rf` of the temporary dir.
  - **`readVerify`** in `src/config.ts`, in the same style as `readChannel`.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Run `bun run test && bun run typecheck`. Expected: both exit 0.
- [ ] **Step 6: Commit.** `git add src/evidence src/config.ts src/engine/git.ts tests/evidence tests/engine/git.test.ts tests/config.test.ts && git commit -m "feat(evidence): verify runner, temporary worktrees and verify config"`

---

## Task 4: Engine integration: state, counters, next step, gate-only checks, card — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4, 4.5
**Difficulty:** Hard
**Blocked by:** Task 2

**Files:**
- Modify:
  - `src/engine/state-types.ts`;
  - `src/engine/snapshot.ts` (`deriveCommentFacts` caps, `SnapshotDeps.caps`, issue url, incomplete items);
  - `src/engine/counters.ts` (ignore `unit_attempts.*`);
  - `src/engine/next-step.ts` (rules 10–12, `waitingUnits`, new fields);
  - `src/engine/registry.ts` (`at`, `key`, the memo store);
  - `src/engine/checks.ts` (`gate`, `target`);
  - `src/hooks/card-input.ts` (caps);
  - `src/interaction/complete-validate.ts` (caps);
  - `src/hooks/phase-card.ts`, `src/tools/format-step.ts`;
  - `tests/helpers/change-state.ts` and every test that builds `SnapshotDeps` or reads `blockedUnits` (`rg -n "blockedUnits|iterationCap" src tests`).
- Create: `src/evidence/card.ts` (the `evidence` card section, registered on import)
- Test: `tests/engine/next-step.test.ts`, `tests/engine/snapshot.test.ts`, `tests/engine/checks.test.ts`, `tests/engine/counters.test.ts`, `tests/hooks/phase-card.test.ts`, `tests/evidence/card.test.ts`

**Interfaces:**
- Consumes: `deriveUnitEvidence` and `UnitEvidence` (Task 2).
- Produces: `ChangeState.evidence`, `ChangeState.issue.url`, the new `NextStep` fields, `registerCheck(…, { at, key })`, `runChecks(…, { gate, target })`, and the `deriveCommentFacts` and `SnapshotDeps` shapes.

- [ ] **Step 1: Write failing tests.**
  - **flow-engine:**
    - `Started unit from comments` and `Done unit is never started`, through `readChangeSnapshot` over `MemoryWorld` comments;
    - `Blocked unit asks for a stuck report` and `Started unit before the next unit`;
    - `No unit ready`, now worded "waiting units";
    - `Gate-only check skipped on refresh`: a test check registered `{ at: "gate", key: () => "k" }` for `plan` is not called by `runChecks` without `gate`; after one `gate: true` run, a refresh returns its stored results, and with another key, none;
    - `Derived unit attempts`.
  - **Receipted, not ticked:** `nextStep` says "Run unit_finish U<n> again to tick it."
  - **context-injection:** `Evidence shown`, and the `Incomplete` line shows comment items, not ids.
- [ ] **Step 2:** Run `bun run test tests/engine tests/hooks/phase-card.test.ts tests/evidence/card.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`deriveCommentFacts`** gains `evidence` and the incomplete items. `card-input.ts` and `complete-validate.ts` pass `{ iterations: pack.loops.change_iterations, unitAttempts: pack.loops.unit_attempts }`.
  - **Renames:** `blockedUnits` → `waitingUnits` everywhere.
  - **Checks:** `runChecks` resolves the target's checks (phase, or a named gate through `resolveGateTarget`) for `gate: true`. Add `clearGateMemo`, `gateMemoGeneration` and `onGateMemoClear` to `src/engine/registry.ts`.
- [ ] **Step 4:** Run `bun run test && bun run typecheck`. Expected: both exit 0. The pack is unchanged in this task, so no unregistered check appears.
- [ ] **Step 5: Commit.** `git add src/engine src/hooks/card-input.ts src/hooks/phase-card.ts src/tools/format-step.ts src/interaction/complete-validate.ts src/evidence/card.ts tests && git commit -m "feat(engine): unit evidence in change state, next step and gate-only checks"`

---

## Task 5: Unit start and unit finish tools — implements 5

**Covers:** 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
**Difficulty:** Very Hard
**Blocked by:** Task 1, Task 2, Task 3, Task 4

**Files:**
- Create: `src/evidence/refusals.ts`, `src/evidence/verify-env.ts`, `src/evidence/lock.ts`, `src/tools/unit-start.ts`, `src/tools/unit-finish.ts`
- Modify: `src/hooks/session.ts` (`redactionTokens()`, `forgeTarget()`, `shutdownSignal`, `drainEvidence()`, and a `session_shutdown` handler that aborts, then awaits the drain), `src/tools/change-tools.ts`, `tests/tools/helpers.ts` (a `locked` option that posts an approved plan `gate` comment with the current digests)
- Test: `tests/evidence/refusals.test.ts`, `tests/tools/unit-start.test.ts`, `tests/tools/unit-finish.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `classifyCommand`, `forgeEndpoints`;
  - Task 2: records, `deriveUnitEvidence` output in state, `failureSignature`, `progressRecord`, `previousSignature`, `pendingDecision`, `testOnlyCommitCheck`;
  - Task 3: `runVerify`, `classifyRun`, `preExpectation`, `postOk`, `withTempWorktree`, the `Git` additions;
  - Task 4: `ChangeState.evidence`;
  - existing: `decide`, `decisionComment`, `tickUnit`, `prepareWrite`, `requireChange`, `afterForgeWrite`, `registerLivespecTool`.
- Produces: `unitStartRefusal`, `finishMode`, `unitFinishRefusal`, `VerifyEnv`, `verifyEnv`, `withEvidenceLock`, the `Session` additions, and the tools `unit_start` and `unit_finish`.

- [ ] **Step 1: Write failing refusal tests in `refusals.test.ts`.** Use a table over `ChangeState` fixtures (`tests/helpers/change-state.ts`), with one row per refusal in design D10 order; the first refusal that applies wins.
  - Start rows: `Dirty tree`, `Frozen unit`, `Unmet dependency`, `One started unit at a time`, and the refactor-pending refusal.
  - Finish rows, run mode: `Not started` and `Digest changed since start`.
  - Finish rows, reconcile mode: a dirty tree refuses, and a frozen unit refuses.
- [ ] **Step 2: Write failing tool tests in `unit-start.test.ts` and `unit-finish.test.ts`.** Use `toolHarness({ locked: true, … })`. `Verify` commands are small committed `sh` scripts, for example `Verify: \`sh check.sh\`` with `check.sh` testing for a file.
  - **unit-evidence, start:** `Red at pre starts the unit`, `Green at pre is refused`, `Refactor unit must pass at pre`, `Dirty tree`, `Frozen unit`, `Unmet dependency`, `One started unit at a time`, `Restart after an amendment`, `Command not found is not red`, `Blocked Verify is never run` (for both a normal and a pending unit: no spawn and no comment), `Pending start`.
  - **unit-evidence, finish:**
    - `Token redacted everywhere`: the session's `redactionTokens` is stubbed to `["s3cr3t"]`;
    - `First commit touches source`, `Test-only commit becomes the pre`;
    - `Green at post`: the body is diffed line by line, and only U1's status line differs;
    - `Not green at post`, `Not started`;
    - `Crash between receipt and tick`: `updateIssueBody` throws once through a `forge` wrapper. The reconcile run's result and `session.card` show U1 done, with no manual refresh;
    - `Digest changed since start`, `Output tail`, `Token redacted`, `Cap reached`, `Chosen stuck answer restarts the budget`, `Dismissed stuck answer keeps the block`.
  - **decision-seam, end to end:** `Two identical failures stop early`, through two `unit_finish` calls whose `Verify` prints the same failure with a different `$(date +%s%N)`.
  - **Review Focus 4:**
    - `parallel unit_finish posts one receipt and one tick`: `Promise.all` of two `unit_finish U1` calls gives exactly one `receipt` comment and one body write; the second reports nothing to finish;
    - `tick conflict re-reads once`: `updateIssueBody` returns `{ status: "conflict" }` once, then the retry ticks exactly once.
  - **Abort:** `aborted post run is not an attempt`. The tool signal aborts during `Verify`; the tool refuses, no `progress` record is posted, and `unit_attempts.U1` is unchanged.
  - **Review Focus 5:** `session shutdown kills a running Verify and cleans up`. Register the session hooks on the harness `FakePi`, start `unit_finish` on a pending unit whose test-only commit `Verify` is `sleep 30` (so it runs in a temporary worktree), then fire `session_shutdown`. Await the tool call: it refuses. No `sleep 30` process remains, `git worktree list` has one line, no `livespec-verify-*` dir remains, and no receipt or `progress` comment was posted. Second case: when the session signal is already aborted, `unit_start` refuses without spawning.
  - **Shutdown waits for cleanup.** The `session_shutdown` handler aborts the controller and then awaits `session.drainEvidence()`, which resolves when the evidence lock chain is empty. The handler returns only after cleanup.
  - **`extra parameters are ignored`:** `{ unit: "U1", exit: 0, verdict: "green" }` behaves like `{ unit: "U1" }`.
  - **No push:** no `push` appears in `gitCalls`.
- [ ] **Step 3:** Run `bun run test tests/evidence/refusals.test.ts tests/tools/unit-start.test.ts tests/tools/unit-finish.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement `refusals.ts`.** Each refusal is a small named rule in an ordered array, as in `src/engine/gates.ts` `REFUSALS`. `unitFinishRefusal(…, "reconcile")` applies only the clean-tree, frozen and stale rules.
- [ ] **Step 5: Implement the `Session` additions, `lock.ts` and `verify-env.ts`.**
  - `connect` stores the token list it already computes.
  - `session_shutdown` aborts an `AbortController` owned by the session.
  - `verifyEnv` combines `AbortSignal.any([toolSignal, session.shutdownSignal])`.
- [ ] **Step 6: Implement `unit-start.ts`.** Under `withEvidenceLock(issue)`:
  1. `prepareWrite`, which refreshes;
  2. `requireChange`;
  3. `unitStartRefusal`;
  4. `verifyEnv`;
  5. `env.run.guard(verify)`: a block refuses and points to `unit_amend`, before the pending decision and before any write;
  6. the pending decision, through `git.pathExistsAt(HEAD, f)`;
  7. for a unit that is not pending, `runVerify` in `root`, then `classifyRun` against `preExpectation`;
  8. post `startComment`;
  9. `afterForgeWrite`.
- [ ] **Step 7: Implement `unit-finish.ts`.** Under `withEvidenceLock(issue)`:
  1. `prepareWrite`, which refreshes, and `requireChange`.
  2. Compute `finishMode`, then `unitFinishRefusal(…, mode)`.
  3. **Reconcile:** `tick(issue)`, then `afterForgeWrite`, then return. The tool result's next step no longer names the unit.
  4. **Pending unit:** `revList(<pre>..HEAD)[0]`, `changedPaths`, `testOnlyCommitCheck`, then `withTempWorktree` and `runVerify`, which must be red.
  5. `runVerify` at HEAD. An `aborted` run refuses and writes nothing.
  6. **Green:** post `receiptComment`, then `tick(issue)`, defined below.
  7. **Not green:** `failureSignature` and `previousSignature`, then `decide("progress", …)`, `progressRecord` and `decisionComment`. The result text includes links built from `state.issue.url` and comment ids.
  8. `afterForgeWrite`.

  **`tick(issue)`:**
  - Read the issue and apply `tickUnit`, then write with its version.
  - On a `conflict` result, re-read once. If the unit is already done, return; otherwise tick again.
  - A thrown transport error propagates, and reconcile later handles that state.
- [ ] **Step 8: Register both tools** in `change-tools.ts` through `registerLivespecTool`, with `parameters: { type: "object", properties: { unit: { type: "string" } }, required: ["unit"] }`. Pass the `execute` `signal` on.
- [ ] **Step 9:** Run the tests from Step 3. Expected: PASS.
- [ ] **Step 10:** Run `bun run test && bun run typecheck`. Expected: both exit 0.
- [ ] **Step 11: Commit.** `git add src/evidence src/tools src/hooks/session.ts tests/evidence tests/tools && git commit -m "feat(tools): unit_start and unit_finish with receipts, attempts and blocked units"`

---

## Task 6: Verify-red-on-base check, spec_gate and the default pack — implements 6

**Covers:** 6.1, 6.2, 6.3, 6.4
**Difficulty:** Hard
**Blocked by:** Task 3, Task 4, Task 5

**Files:**
- Create: `src/evidence/red-on-base.ts`
- Modify: `src/tools/spec-gate.ts`, `src/packs/agent-skills.yaml`, `tests/fixtures/agent-skills.pack.json`, `src/engine/pack-load.ts` (import `../evidence/red-on-base.ts` for its side effect, as with `./checks.ts`), `src/hooks/session.ts` (`clearGateMemo()` at `session_start` and `session_shutdown`)
- Test: `tests/evidence/red-on-base.test.ts`, `tests/tools/spec-gate.test.ts`, `tests/interaction/complete.test.ts`, `tests/engine/pack-load.test.ts`

**Interfaces:**
- Consumes: `withTempWorktree`, `runVerify`, `classifyRun`, `pendingDecision`, `VerifyEnv` and `verifyEnv` (Task 5), `registerCheck(…, { at: "gate", waivable: true, key })`, and `runChecks(…, { gate: true, target })`.
- Produces: the check `verify-red-on-base`, `setRedOnBaseEnv`, and the pack change.
- The check is registered at import of `red-on-base.ts`, which `pack-load.ts` imports. So whenever the pack lists it, it is registered.
- Without an environment (no provider, or no session), the check returns one `error`: "verify-red-on-base cannot run: no livespec session". Like any failing waivable check, this sends the human gate request with `waive` offered, and a plain approve cannot pass it.
- Tests set the provider with `setRedOnBaseEnv(() => verifyEnv(harness.session))` in `beforeEach` and reset it with `setRedOnBaseEnv(async () => undefined)` in `afterEach`.

- [ ] **Step 1: Write failing tests.**
  - **unit-evidence:**
    - `Green on base refuses the plan gate`: the human gate offers `waive` for `verify-red-on-base`;
    - `Pending unit exempt`, `Refactor without a test`, `Missing toolchain is not red`;
    - `Memoized`: runs are counted through a `Verify` that appends to a counter file outside the repository; a second `spec_gate plan` with the same digests adds nothing, and changing one unit reruns only that unit;
    - `Blocked Verify is never run`, check part;
    - `missing environment cannot be approved without a waiver`: with no provider, `spec_gate plan` sends the request with the `verify-red-on-base` error in its payload and `waive` offered, and a plain `/livespec approve` is recorded as superseded;
    - `memo is scoped to the session`: after `clearGateMemo()` (what `session_start` calls), the next gate spawns `Verify` again for every unit, as the counter file grows by the number of units.
  - **phase-gates:**
    - `Gate-only check runs at the gate`;
    - `Forge answer completed without rerunning gate-only checks`: call `resetRegistryForTests()` and re-register the check to simulate a new process, then complete `/livespec approve` through `pollApprovals`; the counter file is unchanged.
  - **flow-pack:** `Default pack contents` and `Spot check`, against the updated fixture.
- [ ] **Step 2:** Run `bun run test tests/evidence/red-on-base.test.ts tests/tools/spec-gate.test.ts tests/interaction/complete.test.ts tests/engine/pack-load.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **The check:** for each unit, `pendingDecision` at `Base`, then the per-unit cache, then `withTempWorktree(Base)` and `runVerify`, then `classifyRun` against `preExpectation`. The key and the cache include `root`. `red-on-base.ts` registers `onGateMemoClear(() => unitCache.clear())` at import.
  - **Session:** `src/hooks/session.ts` calls `clearGateMemo()` in its `session_start` and `session_shutdown` handlers.
  - **`spec_gate`:** before `gateRefusal`, rebuild the state with the gate checks:

    ```ts
    state = { ...state, checks: await runChecks(pack, state, { root, git }, { gate: true, target }) };
    ```

  - **Pack and fixture:** add `verify-red-on-base` and `decisions.progress`.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Run `bun run test && bun run typecheck`. Expected: both exit 0.
- [ ] **Step 6: Commit.** `git add src/evidence/red-on-base.ts src/tools/spec-gate.ts src/packs/agent-skills.yaml src/engine/pack-load.ts src/hooks/session.ts tests && git commit -m "feat(evidence): verify-red-on-base gate-only check"`

---

## Task 7: Work-in-progress predicate — implements 7

**Covers:** 7.1, 7.2
**Difficulty:** Normal
**Blocked by:** Task 2

**Files:**
- Create: `src/evidence/wip.ts`
- Test: `tests/evidence/wip.test.ts`

**Interfaces:**
- Consumes: `registerWorkInProgress` and `resetWorkInProgressForTests` (`src/content/wip.ts`); `readMarkedComments`; `deriveUnitEvidence`; `parseChange`.
- Produces: `startedUnitWorkInProgress: WorkInProgressFn` and `registerStartedUnitWorkInProgress()`. Registration is explicit and is called from `src/extension.ts` in Task 8.

- [ ] **Step 1: Write failing tests.**
  - **unit-evidence:**
    - `Started unit blocks upgrades`: the reason names `#7` and `U2`;
    - `Between units`: `busy: false`.
  - **agent-skills-content:** `Build in progress`, `Pending units without a started unit`, `Manual update refused in build` and `Rollback allowed in build`, over `MemoryWorld` with the predicate registered and the content manager from `tests/content/helpers.ts`.
  - `afterEach` calls `resetWorkInProgressForTests`.
- [ ] **Step 2:** Run `bun run test tests/evidence/wip.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the predicate.**
  1. `forge.searchIssues({ labels: [livespec, phase/build], state: "open" })`, sorted by number;
  2. `readMarkedComments` for each issue;
  3. `deriveUnitEvidence` with no cap.

  The first started unit wins.
- [ ] **Step 4:** Run the same test, then `bun run test && bun run typecheck`. Expected: PASS, then both exit 0.
- [ ] **Step 5: Commit.** `git add src/evidence/wip.ts tests/evidence/wip.test.ts && git commit -m "feat(evidence): work in progress from started units"`

---

## Task 8: Guard and settle hooks, wiring and docs — implements 8

**Covers:** 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
**Difficulty:** Hard
**Blocked by:** Task 1, Task 4, Task 5, Task 6, Task 7

**Files:**
- Create: `src/guard/push.ts`, `src/hooks/guard.ts`, `src/hooks/settle.ts`
- Modify: `src/extension.ts`, `tests/hooks/fake-pi.ts` (`fire` stops at the first `tool_call` result with `block: true`, as pi's runner does), `docs/architecture.md`
- Test: `tests/hooks/guard.test.ts`, `tests/hooks/settle.test.ts`, `tests/guard/push-callers.test.ts`, `tests/e2e/build-flow.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `classifyCommand`, `forgeEndpoints`, `isLivespecPath`;
  - Task 5: `Session.forgeTarget()`;
  - Task 4: `ChangeState.evidence` and `incomplete`;
  - Task 6: `setRedOnBaseEnv`; Task 5: `verifyEnv`;
  - Task 7: `registerStartedUnitWorkInProgress`;
  - existing: `writeMarked`, own-comment editing as in `setCounter`.
- Produces: `guardedPush`, `registerGuardHook(pi)`, `registerSettleHooks(pi)` and `registerSettleCondition`.

- [ ] **Step 1: Write failing tests.**
  - **`tests/guard/push-callers.test.ts`:** `No tool calls the push path` scans `src/tools/**/*.ts` for `guard/push`.
  - **`tests/hooks/guard.test.ts`**, through `FakePi` with `extension()` loaded and a `toolHarness`-style session:
    - `Reason names the tool`;
    - `Guard error blocks`: `vi.spyOn` makes `classifyCommand` throw;
    - `Flow override edit blocked`: `edit` on `.pi/livespec/flow.yaml`, and the file is unchanged;
    - `Path traversal`: a `write`;
    - `Manual tick blocked`: blocked, and the `MemoryWorld` issue body is unchanged;
    - `guard runs before skill-read recording`: a blocked `bash` call does not reach the context hook, and a valid skill `read` is still recorded;
    - in an uninitialized project, every call is allowed.
  - **`tests/hooks/settle.test.ts`**, firing `agent_before_settle` and `agent_settled`:
    - `Not in build`, `Registered condition`;
    - `Exactly one continuation`, `New prompt gets a new continuation`;
    - `Incomplete posted and shown`, `Cleared after finishing`, `Cleared after the phase moved on`;
    - `Read-only forge`;
    - an `aborted` outcome returns nothing.
  - **`tests/e2e/build-flow.test.ts`**, in `build`:
    1. `unit_start U1` is red;
    2. commit the fix;
    3. `unit_finish U1` is green;
    4. the receipt is posted and U1 is ticked;
    5. a `bash` `tool_call` of `gh issue edit 1 --body x` is blocked, and so is `git push`;
    6. the following settle requests nothing.
- [ ] **Step 2:** Run `bun run test tests/hooks/guard.test.ts tests/hooks/settle.test.ts tests/guard/push-callers.test.ts tests/e2e/build-flow.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `src/guard/push.ts`.** It runs `git push -- <remote> <refspec>` through `GitExec` and throws `GitError` on a non-zero exit.
- [ ] **Step 4: Implement `src/hooks/guard.ts` `registerGuardHook(pi)`.**
  - `bash` → `classifyCommand(command, { cwd: ctx.cwd, endpoints: forgeEndpoints(session.forgeTarget(), session.config.project), aliases })`. The aliases come from `session.git.aliases()` only when the text contains `git`; a failure gives `"unknown"`.
  - `write` or `edit` → `isLivespecPath(ctx.cwd, input.path)`.
  - Any throw → `{ block: true, reason: "livespec guard failed: <message>; the command was not run" }`.
- [ ] **Step 5: Implement `src/hooks/settle.ts` `registerSettleHooks(pi)`.**
  - `settleItems(state)` is pure.
  - `agent_before_settle`: return when the outcome is not `completed`; otherwise `await session.refresh()`, then:
    - items and `!asked` → `asked = true`, and return the continuation with a `livespec-settle` custom message;
    - items and `asked` → write `incomplete`;
    - no items and listed incomplete items → clear them.
  - `agent_settled` resets `asked`.
  - Writes go through `requireWritable`; a refusal is recorded as a warning.
  - Everything sits in try/catch → `session.record("settle", error)`.
- [ ] **Step 6: Wire `src/extension.ts`.**
  1. `registerGuardHook(pi)` first;
  2. then the existing registrations;
  3. `registerSettleHooks(pi)`;
  4. `registerStartedUnitWorkInProgress()`;
  5. `setRedOnBaseEnv(async () => { const s = getSession(); return s?.initialized ? verifyEnv(s) : undefined; })`;
  6. import `./evidence/card.ts` for its side effect.
- [ ] **Step 7:** Run the tests from Step 2. Expected: PASS.
- [ ] **Step 8: Update `docs/architecture.md`.**
  - Mark `unit_start`/`unit_finish`, the `tool_call` guard and `agent_before_settle` as built in the module box.
  - Add a section "Evidence and guards". It covers receipts and `unit-start`, attempts and `BLOCKED`, `verify-red-on-base` at the plan gate, `verify.setup`, a summary of the guard rules, `guardedPush`, settle, and the accepted limits: script files, pushes outside pi, and executors that do not load the extension.
  - Remove the first two "Known gaps" bullets and their "LS-06 closes" sentence.
- [ ] **Step 9:** Run `bun run test && bun run typecheck`. Expected: both exit 0.
- [ ] **Step 10: Commit.** `git add src/guard/push.ts src/hooks/guard.ts src/hooks/settle.ts src/extension.ts tests/hooks tests/guard tests/e2e docs/architecture.md && git commit -m "feat(hooks): command guard, settle continuation and incomplete marker"`

---

## Scenario → test

Test files are under `tests/`. Each test name equals the scenario title.

**unit-evidence**
- Red at pre starts the unit → `tools/unit-start.test.ts`
- Green at pre is refused → `tools/unit-start.test.ts`
- Refactor unit must pass at pre → `tools/unit-start.test.ts`
- Dirty tree → `tools/unit-start.test.ts`, `evidence/refusals.test.ts`
- Frozen unit → `tools/unit-start.test.ts`, `evidence/refusals.test.ts`
- Unmet dependency → `tools/unit-start.test.ts`, `evidence/refusals.test.ts`
- One started unit at a time → `tools/unit-start.test.ts`, `evidence/refusals.test.ts`
- Restart after an amendment → `tools/unit-start.test.ts`
- Command not found is not red → `evidence/runner.test.ts`, `tools/unit-start.test.ts`
- Blocked Verify is never run → `evidence/runner.test.ts`, `tools/unit-start.test.ts`, `evidence/red-on-base.test.ts`
- Token redacted everywhere → `tools/unit-finish.test.ts`
- Timeout → `evidence/runner.test.ts`
- Pending start → `tools/unit-start.test.ts`
- First commit touches source → `tools/unit-finish.test.ts`
- Test-only commit becomes the pre → `tools/unit-finish.test.ts`
- Green at post → `tools/unit-finish.test.ts`
- Not green at post → `tools/unit-finish.test.ts`
- Not started → `tools/unit-finish.test.ts`, `evidence/refusals.test.ts`
- Crash between receipt and tick → `tools/unit-finish.test.ts`
- Digest changed since start → `tools/unit-finish.test.ts`, `evidence/refusals.test.ts`
- Output tail → `evidence/output.test.ts`, `tools/unit-finish.test.ts`
- Token redacted → `tools/unit-finish.test.ts`
- Cap reached → `tools/unit-finish.test.ts`
- Chosen stuck answer restarts the budget → `evidence/unit-state.test.ts`, `tools/unit-finish.test.ts`
- Dismissed stuck answer keeps the block → `evidence/unit-state.test.ts`, `tools/unit-finish.test.ts`
- Green on base refuses the plan gate → `evidence/red-on-base.test.ts`
- Pending unit exempt → `evidence/red-on-base.test.ts`
- Refactor without a test → `evidence/red-on-base.test.ts`
- Missing toolchain is not red → `evidence/red-on-base.test.ts`
- Dependencies linked → `evidence/worktree.test.ts`
- Memoized → `evidence/red-on-base.test.ts`
- Started unit blocks upgrades → `evidence/wip.test.ts`
- Between units → `evidence/wip.test.ts`

**command-guards**
- Reason names the tool → `guard/classify.test.ts`, `hooks/guard.test.ts`
- Guard error blocks → `hooks/guard.test.ts`
- Manual tick blocked → `guard/classify.test.ts`, `hooks/guard.test.ts`
- Self-approval comment blocked → `guard/classify.test.ts`
- API write blocked, read allowed → `guard/classify.test.ts`
- Raw HTTP write to the forge host → `guard/classify.test.ts`
- GitHub API host → `guard/classify.test.ts`
- Tea write blocked → `guard/classify.test.ts`
- Push variants blocked → `guard/classify.test.ts`
- Push alias blocked → `guard/classify.test.ts`
- Pull request commands blocked → `guard/classify.test.ts`
- Ordinary git allowed → `guard/classify.test.ts`
- Eval blocked → `guard/classify.test.ts`
- Variable git subcommand → `guard/classify.test.ts`
- Variable command word → `guard/classify.test.ts`
- Harmless eval allowed → `guard/classify.test.ts`
- Script file allowed → `guard/classify.test.ts`
- Flow override edit blocked → `hooks/guard.test.ts`
- Shell write blocked → `guard/classify.test.ts`
- Path traversal → `guard/paths.test.ts`, `hooks/guard.test.ts`
- Directory change before the write → `guard/classify.test.ts`, `guard/paths.test.ts`
- Read allowed → `guard/classify.test.ts`
- No tool calls the push path → `guard/push-callers.test.ts`

**settle-continuation** (all in `hooks/settle.test.ts`)
- Not in build
- Registered condition
- Exactly one continuation
- New prompt gets a new continuation
- Incomplete posted and shown
- Cleared after finishing
- Cleared after the phase moved on
- Read-only forge

**decision-seam**
- Two identical failures stop early → `evidence/progress-rule.test.ts`, `tools/unit-finish.test.ts`
- Different failures retry → `evidence/progress-rule.test.ts`
- Cap with different failures → `evidence/progress-rule.test.ts`
- Unrecognized output → `evidence/progress-rule.test.ts`, `evidence/signature.test.ts`
- Large output keeps the signature → `evidence/progress-rule.test.ts`

**flow-engine** (existing scenarios keep their current tests)
- Started unit from comments → `engine/snapshot.test.ts`, `evidence/unit-state.test.ts`
- Done unit is never started → `engine/snapshot.test.ts`, `evidence/unit-state.test.ts`
- No unit ready (updated wording) → `engine/next-step.test.ts`
- Blocked unit asks for a stuck report → `engine/next-step.test.ts`
- Started unit before the next unit → `engine/next-step.test.ts`
- Gate-only check skipped on refresh → `engine/checks.test.ts`
- Derived unit attempts → `engine/counters.test.ts`, `evidence/unit-state.test.ts`
- Unchanged scenarios: State from fixture issue, Stale state, Ambiguous phase, Pending request and lock from comments, Pure, Last phase, Blocking question first, Missing output, Not started, Next unit, Human gate ready, Pending gate request, Stuck report first, Frozen unit, Dismissed gate, Ship approved, Waived check does not hold the next step, Units check in plan, Only active phase checks, Capabilities mismatch, Counter shown with cap, Counter update edits in place, Derived iteration count → existing tests in `engine/snapshot.test.ts`, `engine/next-step.test.ts`, `engine/checks.test.ts` and `engine/counters.test.ts`, kept green.

**flow-pack**
- Default pack loads → `engine/pack-load.test.ts`
- Default pack contents → `engine/pack-load.test.ts`, with the updated fixture
- Spot check → `engine/pack-load.test.ts`

**phase-gates**
- Gate-only check runs at the gate → `tools/spec-gate.test.ts`
- Forge answer completed without rerunning gate-only checks → `interaction/complete.test.ts`
- Unchanged scenarios: Blocking question keeps the gate closed, Failing check that is not waivable, Self gate, Registered gate, Named gate option recorded, Named gate option does not waive → existing tests in `tools/spec-gate.test.ts`

**agent-skills-content**
- Build in progress → `evidence/wip.test.ts`
- Pending units without a started unit → `evidence/wip.test.ts`
- Manual update refused in build → `evidence/wip.test.ts`
- Rollback allowed in build → `evidence/wip.test.ts`

**init-and-doctor**
- Verify settings → `config.test.ts`
- Invalid verify timeout → `config.test.ts`
- Unchanged scenarios: Unknown key, Interaction adapter list, Unknown adapter name → existing tests in `config.test.ts`

**context-injection**
- Evidence shown → `hooks/phase-card.test.ts`
- Unchanged scenarios: Card contents, Stale card, Registered section, Pending approvals shown, Ignored command shown → existing tests in `hooks/phase-card.test.ts`
