# Machine Ledger (LS-12a) Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md` (decisions D1–D12, D3b).

**Goal:** Move the `decision`, `dispatch`, `finding-summary`, `receipt`, `unit-start` and `counter` records from forge comments to an append-only git ledger on `refs/livespec/<issue>`, with safe concurrent sync and no lost records.

**Architecture:** A new `src/ledger/` module owns the ref: entry codec, plumbing commits with compare-and-swap, sync (fetch, fast-forward, replay, push) through guarded git paths in `src/guard/push.ts`, and a merge that interleaves ledger entries with the remaining own marked comments by causal `after` anchors. One seam, `readOwnRecords`, gives every reader the merged list, so readers barely change; writers move kind by kind, and forge markers stop accepting ledger kinds only after every writer moved.

**Tech Stack:** TypeScript (`bun run typecheck` = `tsc --noEmit`), vitest (`bun run test`), git CLI through `GitExec` (no stdin), `yaml`.

## Global Constraints

- Ledger kinds are exactly `decision`, `dispatch`, `finding-summary`, `receipt`, `unit-start`, `counter`; every other kind stays a forge comment.
- Ref `refs/livespec/<n>`, tracking ref `refs/livespec-origin/<n>`, remote always `origin`; `<n>` a positive integer.
- `ref` format `<id>~<8 lowercase hex>`; `seq` 1-based; `at` ISO 8601 UTC; `ledger.yaml` `schema: 1`.
- Append CAS retries: 5. Push restarts on rejection: 3.
- Ledger commits always use author and committer `livespec <livespec@localhost>`.
- `ledger.retain`: project config, boolean, default `true`.
- State reads use local refs only, except the first fetch of a change per session from a tool refresh.
- No new dependency. `GitExec` keeps its signature (plumbing via temp files and a temp `GIT_INDEX_FILE`).
- The plan gate's cascade baseline stays on the `gate` comment (design Non-Goals).
- The suite is green after every task.
- Before Task 1: `git fetch origin && git log --oneline HEAD..origin/main`. If main moved and changed a baseline spec of this change, re-copy those MODIFIED blocks and re-apply the ledger edits before coding.

## Review Focus

1. **Two writers, same ref.** Concurrent appends from two worktrees and two clones; replay keeps every entry exactly once (Tasks 2, 4).
2. **Order across stores.** Ledger entry vs later `rebuild`/`parked`/`stuck` comment; replay renumbering `seq` must not change "latest" (Task 5).
3. **Second machine before fetch.** A clone that never fetched must not read an empty ledger and write a duplicate `unit-start` (Tasks 4, 6).
4. **Readers outside the snapshot.** Poll, decide reuse, forge open-request check, wip and feedback round must see ledger records (Task 5, poll test in Task 8).
5. **Hostile ledger content.** Malformed lines, wrong schema, wrong kind in a file, duplicate refs are skipped with warnings, never crash a tool (Task 2).

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `MarkedComment` (`src/forge/markers.ts`) | modified | `{ ref: string; source: "forge" \| "ledger"; kind: string; id: string; author: string; data: unknown; createdAt?: string; from?: string }` (`commentId` renamed `ref`; `createdAt` set for forge comments and entries (`at`); `from` and `after?` copied from entries — `after` added in Task 10 so packet sources can recompute `entryVersion`) | no |
| `LEDGER_KINDS` (`src/core/record-kinds.ts`) | new | `readonly ["decision","dispatch","finding-summary","receipt","unit-start","counter"]`; `type LedgerKind = (typeof LEDGER_KINDS)[number]`; `isLedgerKind(k: string): k is LedgerKind` | no |
| `LedgerEntry` (`src/ledger/entry.ts`) | new | `{ ref: string; kind: LedgerKind; id: string; seq: number; at: string; after?: string; from?: string; data: unknown }` | no |
| Ledger tree format | new | `ledger.yaml` `{ schema: 1, issue: <n> }`; `decisions.jsonl`, `dispatch.jsonl`, `findings.jsonl` (one JSON entry per line); `units/<U>.yaml`, `change.yaml` (YAML sequence of entries); `fileFor(kind, data)`: `units/<data.unit>.yaml` for `unit-start`/`receipt`, `change.yaml` for `counter` | yes (read by auditors with `git show`) |
| `entryVersion(e: LedgerEntry): string` | new | sha256 hex of sorted-key, whitespace-free JSON of `{ ref, kind, id, at, after?, from?, data }` | no |
| `AppendInput` | new | `{ kind: LedgerKind; id: string; data: unknown; after?: string }` | no |
| `LedgerRead` | new | `{ tip?: string; entries: LedgerEntry[]; warnings: string[] }` | no |
| Store functions (`src/ledger/store.ts`) | new | `readTree(exec, root, commit, n): Promise<LedgerRead>`; `readLedger(exec, root, n): Promise<LedgerRead>`; `commitEntries(exec, root, n, base: string \| undefined, entries: LedgerEntry[]): Promise<string>` (new commit sha); `appendEntry(exec, root, n, input: AppendInput, now?: () => Date): Promise<LedgerEntry>` | no |
| `LedgerError` | new | `class LedgerError extends Error { code: "kind" \| "cas" \| "unknown-offline" \| "git" }` | no |
| Guarded ledger paths (`src/guard/push.ts`) | new | `ledgerFetch(exec, root, n): Promise<"fetched" \| "absent">`; `ledgerPush(exec, root, n, tip): Promise<"pushed" \| "rejected">`; `ledgerDelete(exec, root, n, tip): Promise<"deleted" \| "gone" \| "moved">`; each throws before running git when `n` is not a positive integer, throws `GitError` on other failures | no |
| `SyncResult` | new | `{ status: "synced" } \| { status: "pending"; reason: string } \| { status: "error"; message: string }` | no |
| `FetchState` | new | `"fetched" \| "stale-known" \| "unknown-offline"` | no |
| `Ledger` (`src/ledger/index.ts`) | new | `read(n)`; `append(n, input): Promise<LedgerEntry>`; `ensureFetched(n): Promise<FetchState>`; `sync(n): Promise<SyncResult>`; `pending(n): Promise<boolean>`; `remove(n): Promise<{ remote: "deleted" \| "gone" \| "moved" \| "failed"; message?: string }>`; `background(): Promise<void>` (settles when every background sync started so far has settled); `createLedger(exec, root): Ledger` | no |
| Merge (`src/ledger/merge.ts`) | new | `mergeRecords(comments: MarkedComment[], entries: LedgerEntry[]): MarkedComment[]`; `matchesRef(m: MarkedComment, ref: string): boolean` (`m.ref === ref \|\| m.from === ref`); `lastForgeRef(marked): string \| undefined` | no |
| `readOwnRecords(forge, ledger, n, o?: { comments?: Comment[]; login?: string })` (`src/ledger/records.ts`) | new | `Promise<{ records: MarkedComment[]; warnings: string[]; stale: boolean }>`; own marked comments of `n` (from `o.comments` when given, else listed) merged with its entries | no |
| `Session.refresh` (`src/hooks/session.ts`) | modified | `refresh(o?: { fetch?: boolean }): Promise<void>`; `fetch` defaults to `true`; the context hook and session start pass `{ fetch: false }` | no |
| `prepareWrite` (`src/tools/guard.ts`) | modified | refuses `the ledger of #<n> could not be fetched; reconnect and retry` when `ensureFetched` returns `unknown-offline`, before any other check | no |
| `decisionBody(input: AppendInput): string` (`src/decide/records.ts`) | new, temporary | wraps a decision input as a marked comment; exists from Task 6 to Task 8 only | no |
| `SnapshotDeps` (`src/engine/snapshot.ts`) | modified | adds `ledger: Ledger; fetch: boolean` | no |
| `WriteContext` (`src/tools/guard.ts`) | modified | `{ session; pack; forge; ledger: Ledger }`; new `afterLedgerWrite(session, n): Promise<void>` (refresh without dropping the comments cache) | no |
| `CompletionCtx` (`src/interaction/complete-effects.ts`) | modified | adds `ledger: Ledger` | no |
| `ApplyFn` / `ResultRecord` | modified | `ApplyFn = (run, record) => Promise<ResultRecord>`; `ResultRecord = { comment: string } \| { entry: AppendInput }`; `appendRecord(run, input): Promise<void>` | no |
| `WorkInProgressFn` (`src/content/wip.ts`) | modified | `(forge: Forge, ledger: Ledger) => Promise<WorkInProgress>`; CLI caller builds `createLedger(defaultGitExec, cwd)` | no |
| Record builders | modified | `decisionComment`, `dispatchComment`, `findingSummaryComment`, `rebuttalComment`, `aggregateComment`, `startComment`, `receiptComment` return `AppendInput` (without `after`); `setCounter(ledger, n, id, value, after?)` | no |
| Dispatch deps (`src/subagents/dispatch.ts`, `LaneOps`) | modified | `record(input: AppendInput): Promise<void>` replaces `post(body)` for ledger kinds | no |
| `ProjectConfig.ledger` (`src/config.ts`) | new | `{ retain: boolean }`; key `ledger.retain`; default `true` | yes (config key) |
| Packet source id | modified | adds `ledger:<issue>/<ref>`, versioned by `entryVersion`; `records:decisions` names entries by that id | yes (child-visible) |
| `finding_rebut` first parameter | modified | `comment` → `ref`: a `finding-summary` entry `ref` (or a migrated `from`) | yes (tool API) |
| Verifier `finding` parameter | modified | `<aggregateRef>:<index>`; accepted when the part before the last `:` names an aggregate by `ref` or `from` | yes (tool API) |
| Question text key | modified | `finding:<aggregateRef>:<index>` | yes (forge text) |

---

## Task 1: Record identity refactor — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/forge/markers.ts`, each `src/**` and `tests/**` file that uses `MarkedComment.commentId` (`grep -rln commentId src tests`), `src/interaction/complete-effects.ts` (`postComment` push)
- Test: `tests/interaction/spec-cascade-plan.test.ts`

**Interfaces:**
- Produces: `MarkedComment` (Contracts).

- [ ] **Step 1:** Add `test("cascade id is stable across the ref rename")` to `spec-cascade-plan.test.ts`: reuse an existing cascade input and assert the planned `id` equals the literal id the current code produces (record it from a run before the rename).
- [ ] **Step 2:** `bunx vitest run tests/interaction/spec-cascade-plan.test.ts` → PASS.
- [ ] **Step 3:** Rename `commentId` → `ref`, add `source: "forge"` and `createdAt` in `filterMarked` and `postComment`; let `bun run typecheck` drive the mechanical rename incl. test literals (`tests/subagents/helpers.ts` `mark`, `tests/evidence/unit-state.test.ts`, `tests/review/review-fixtures.ts`). `LockBaseline.commentId`/`GateResult.commentId` in `src/engine/locks.ts` keep their names.
- [ ] **Step 4:** `bun run typecheck && bun run test` → all green, Step 1 included.
- [ ] **Step 5:** Commit `refactor(markers): name record references ref and carry their source`.

---

## Task 2: Ledger core — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Create: `src/core/record-kinds.ts`, `src/ledger/entry.ts`, `src/ledger/store.ts`, `tests/ledger/entry.test.ts`, `tests/ledger/store.test.ts`

**Interfaces:**
- Produces: `LEDGER_KINDS`, `LedgerEntry`, `AppendInput`, `LedgerRead`, `LedgerError`, `entryVersion`, `newRef(id)`, `fileFor(kind, data)`, store functions (Contracts).

- [ ] **Step 1:** `entry.test.ts`: `newRef("progress.U1")` matches `/^progress\.U1~[0-9a-f]{8}$/`; `entryVersion` equal for entries differing only in `seq` or in `data` key order, different when `data` differs; `fileFor("receipt", { unit: "U2" }) === "units/U2.yaml"`, `fileFor("counter", {}) === "change.yaml"`, `fileFor("finding-summary", {}) === "findings.jsonl"`.
- [ ] **Step 2:** `store.test.ts` on `makeRepo()`, test names = scenario names: "First record creates the ref" (`ledger.yaml` = `schema: 1, issue: 59`, `units/U1.yaml` one entry, `git merge-base HEAD refs/livespec/59` exits non-zero); "Two records with the same id"; "Unknown kind refused" (`LedgerError` `kind`, ref unchanged); "Two local sessions append at once" (two worktrees, `Promise.all`, `seq` 1 and 2); "Shared between worktrees"; "Dirty tree does not matter" (`git status --porcelain` and `git diff --cached` unchanged); "No git identity" (repo with `user.*` unset, env `HOME=<empty dir>`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; author and committer `livespec <livespec@localhost>`); a repo with `user.name` set still commits as `livespec`; "Corrupt line" (tree committed by `commitEntries` plus a hand-written bad line; 1 entry, 1 warning naming `findings.jsonl`); "Unknown schema"; duplicate `ref` skipped with warning; `decision` entry inside `findings.jsonl` skipped with warning.
- [ ] **Step 3:** `bunx vitest run tests/ledger` → FAIL (modules missing).
- [ ] **Step 4:** Implement. Blob: write file content to a temp file, `hash-object -w -- <file>`. Tree: temp `GIT_INDEX_FILE`, `read-tree <base>` or `read-tree --empty`, `update-index --add --cacheinfo 100644,<blob>,<path>` per changed file, `write-tree`. Commit: `commit-tree <tree> [-p <base>] -m "livespec: <kind> <id>"` with `GIT_AUTHOR_NAME`/`EMAIL` and `GIT_COMMITTER_NAME`/`EMAIL` always set to `livespec`/`livespec@localhost`. `appendEntry`: read tip, `seq = max + 1`, `commitEntries`, `update-ref refs/livespec/<n> <new> <tip or "">`; on failure re-read and retry ≤5, then `LedgerError("cas")`. Reads: `ls-tree -r --full-tree <tip>`, `cat-file blob <sha>` per file, cache keyed by tip.
- [ ] **Step 5:** `bunx vitest run tests/ledger && bun run typecheck` → PASS.
- [ ] **Step 6:** Commit `feat(ledger): append-only entry store on refs/livespec/<issue>`.

---

## Task 3: Guarded ledger git paths and guard rule — implements 3

**Covers:** 3.1, 3.2, 3.3
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Modify: `src/guard/push.ts`, `src/guard/rules.ts`, `src/guard/classify.ts`
- Test: `tests/guard/push-callers.test.ts`, `tests/guard/classify.test.ts`

**Interfaces:**
- Produces: guarded ledger paths (Contracts).

- [ ] **Step 1:** `push-callers.test.ts`: "Ledger push refspec" (recording `GitExec`: exactly `["push", "--", "origin", "t:refs/livespec/59"]`); fetch args `["fetch", "--", "origin", "+refs/livespec/59:refs/livespec-origin/59"]`; delete args `["push", "--force-with-lease=refs/livespec/59:t", "--", "origin", ":refs/livespec/59"]`; "Ledger operations refuse a bad issue number" (`0`, `-1`, `"59 --force"` throw, zero exec calls); "No tool calls the push path" extended: ledger operations referenced only by `src/ledger/sync.ts` (which also hosts the delete used by `Ledger.remove`); relax the "every importer is under `src/tools/`" assertion to admit exactly `src/ledger/sync.ts` besides the five tools.
- [ ] **Step 2:** `classify.test.ts`: "Agent ledger writes blocked" (the five commands of the scenario); "Agent ledger reads allowed" (`git show refs/livespec/59:findings.jsonl`, `git log refs/livespec/59`, `git cat-file -p refs/livespec/59`); `git fetch origin` and `git fetch origin '+refs/heads/*:refs/remotes/origin/*'` allowed.
- [ ] **Step 3:** `bunx vitest run tests/guard` → FAIL.
- [ ] **Step 4:** Implement the three functions (`ledgerFetch`: `ls-remote --exit-code -- origin refs/livespec/<n>` code 2 → `"absent"`, else fetch; `ledgerPush`: stderr containing `rejected`, `fetch first` or `non-fast-forward` → `"rejected"`; `ledgerDelete`: same shape as `guardedDeleteWip`). Add a `ledger` rule in `rules.ts` applied to unwrapped git invocations: block when an arg contains `refs/livespec` or `livespec-origin` and the subcommand is not in `log, show, cat-file, rev-parse, rev-list, ls-tree, ls-remote, for-each-ref, diff`; block `update-ref --stdin`; block `fetch`/`push` refspecs whose destination has `*` and does not start with `refs/remotes/`. Reason: `the ledger is written only by livespec tools`.
- [ ] **Step 5:** `bunx vitest run tests/guard && bun run typecheck` → PASS.
- [ ] **Step 6:** Commit `feat(guard): guarded ledger fetch, push and delete; block agent ledger writes`.

---

## Task 4: Sync, fetch before use, retention plumbing — implements 4

**Covers:** 4.1, 4.2, 4.3, 4.4
**Difficulty:** Very Hard
**Blocked by:** Task 2, Task 3

**Files:**
- Create: `src/ledger/sync.ts`, `src/ledger/index.ts`, `tests/ledger/sync.test.ts`, `tests/ledger/fixtures.ts`

**Interfaces:**
- Consumes: Task 2 store; Task 3 guarded paths.
- Produces: `Ledger`, `createLedger`, `SyncResult`, `FetchState`.

- [ ] **Step 1:** `fixtures.ts`: `twoClones()` → `{ remote, a, b }` (bare repo, two clones with identities); `offline(clone)` (points `remote.origin.url` at a missing path).
- [ ] **Step 2:** `sync.test.ts`: "Two machines append concurrently" (both append from the same synced tip; A syncs; B's sync replays; both end with the same entries, each `ref` once); "Remote ledger absent"; "Offline append" (`pending`, `pending(n)` true); "Pending entries pushed later"; "Version kept across a replay"; "Second machine sees the first machine's records"; "New change, empty remote" (`"fetched"`); "Unknown ledger while offline" (`"unknown-offline"`, `append` throws `LedgerError("unknown-offline")`); "Known ledger while offline" (`"stale-known"`, append ok); no `origin` remote → `"fetched"`; remote ref deleted → tracking ref cleared; `remove`: deleted (local and tracking gone), `failed` offline (local gone), `moved` mapped.
- [ ] **Step 3:** `bunx vitest run tests/ledger/sync.test.ts` → FAIL.
- [ ] **Step 4:** Implement `sync(n)` per ledger-store "Ledger sync" (replay: entries of local `readTree` whose `ref` is not in remote, in local file order, via `commitEntries(remoteTip, entries renumbered)`, CAS on local, restart on lost CAS; push ≤3 restarts); `pending(n)` via `merge-base --is-ancestor <local> <tracking>`; `createLedger` with a session `Set<number>` for `ensureFetched` and `background()` returning `Promise.allSettled` of every non-awaited sync still running; `remove` calls a `removeRemote` in `sync.ts`.
- [ ] **Step 5:** `bunx vitest run tests/ledger && bun run typecheck` → PASS.
- [ ] **Step 6:** Commit `feat(ledger): sync with fetch, replay and fast-forward-only push`.

---

## Task 5: Change state and reader seam — implements 5

**Covers:** 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
**Difficulty:** Hard
**Blocked by:** Task 1, Task 4

**Files:**
- Create: `src/ledger/merge.ts`, `src/ledger/records.ts`, `tests/ledger/merge.test.ts`
- Modify: `src/engine/snapshot.ts`, `src/hooks/session.ts`, `src/hooks/card-input.ts`, `src/hooks/context.ts`, `src/tools/guard.ts`, `src/interaction/complete-effects.ts`, `src/interaction/session-ctx.ts`, `src/interaction/poll.ts`, `src/interaction/forge.ts`, `src/tools/approver-for.ts`, `src/tools/decide-ask.ts`, `src/content/wip.ts`, `src/evidence/wip.ts`, `src/commands/deps.ts`, `src/ship/feedback-poll.ts`, `tests/tools/helpers.ts`, `tests/tools/unit-helpers.ts`, `tests/subagents/helpers.ts`, `tests/content/expose.test.ts`, tests asserting `originRefs` unchanged
- Test: `tests/ledger/merge.test.ts`, `tests/engine/snapshot.test.ts`, `tests/interaction/poll.test.ts`, `tests/evidence/wip.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `MarkedComment`.
- Produces: `mergeRecords`, `matchesRef`, `lastForgeRef`, `readOwnRecords`, `Session.refresh({ fetch })`, `Session.ledger`, `WriteContext.ledger`, `CompletionCtx.ledger`, `afterLedgerWrite`, test helpers `h.seed` (ledger kinds → ledger), `h.ofKind` (merged list), `ledgerRecord(input, opts?)`.

- [ ] **Step 1:** `merge.test.ts`: "Receipt before a later rebuild", "Unit start after a park", "Latest counter after a replay" (via `readCounters(mergeRecords(...))`), absent `after` placed by `createdAt <= at`, before-all with no earlier comment, anchor to a deleted comment, file-order ties, "Reference by migrated comment id" (`matchesRef`).
- [ ] **Step 2:** `snapshot.test.ts`: "No ledger"; "Started unit from comments" (entry seeded); "Done unit is never started"; pending-sync warning; first tool refresh fetches and a second does not (recording exec); session-start card and context hook do not fetch; `subagent_packet` on a fresh clone fetches first; "Account switch" with a `stale` comment; "Comments cache hit" still lists comments once. `poll.test.ts`: a decide request answered on the forge whose `decision` is a seeded ledger entry counts as completed. `wip.test.ts`: a `unit-start` entry is reported as work in progress.
- [ ] **Step 3:** Run those files → FAIL.
- [ ] **Step 4:** Implement `merge.ts`, `records.ts`; snapshot calls `readOwnRecords` with its cached comments (ensureFetched when `fetch`), adds ledger warnings; thread `refresh({ fetch })` (default `true`) through `resolveAndSnapshot` → `buildCardInput` → `readChangeSnapshot`, context hook and session start pass `false`; `prepareWrite` refuses on `unknown-offline` first; switch `poll.ts`, `decide-ask.ts`, `interaction/forge.ts` (+ `approver-for.ts` passes the ledger), `evidence/wip.ts` (+ callers `hooks/session.ts`, `commands/deps.ts`), `feedback-poll.ts` to `readOwnRecords`; `Session` builds `createLedger(exec, cwd)` and starts a background sync in `session_start`; `afterLedgerWrite`.
- [ ] **Step 5:** Test helpers: harness awaits `session.ledger.background()` before teardown and before `originRefs`/`gitCalls` snapshots; `originRefs` helper gains `{ ignoreLedger: true }` used where the assertion means "no branch push"; `h.seed` appends ledger kinds; `h.ofKind` reads the merged list; `ledgerRecord` for pure-reader tests.
- [ ] **Step 6:** `bun run typecheck && bun run test` → PASS. Writers still post comments of ledger kinds and the merged list includes them, so behaviour is unchanged.
- [ ] **Step 7:** Commit `feat(engine): read own records from forge comments and the ledger`.

---

## Task 6: Evidence and planning writers — implements 6

**Covers:** 6.1, 6.2, 6.3, 6.4
**Difficulty:** Hard
**Blocked by:** Task 5

**Files:**
- Modify: `src/evidence/records.ts`, `src/decide/records.ts`, `src/engine/counters.ts`, `src/tools/unit-start.ts`, `src/tools/unit-finish.ts`, `src/tools/plan-units-steps.ts`, `src/review/stages.ts` and `src/interaction/complete-decide.ts`/`complete-overrides.ts`/`complete-amend.ts` (call sites only: `decisionComment(x)` → `decisionBody(decisionComment(x))`)
- Test: `tests/tools/unit-start.test.ts`, `tests/tools/unit-finish.test.ts`, `tests/tools/unit-finish-findings.test.ts`, `tests/tools/plan-units.test.ts`, `tests/tools/spec-gate.test.ts`, `tests/tools/change-split.test.ts`, `tests/engine/gates.test.ts`, `tests/engine/counters.test.ts`, `tests/ship/context.test.ts`, `tests/e2e/spec-cascade.test.ts`, `tests/evidence/records.test.ts`, `tests/evidence/red-on-base.test.ts`, `tests/evidence/wip.test.ts`, `tests/evidence/progress-rule.test.ts`, `tests/engine/checks.test.ts`, `tests/engine/snapshot.test.ts`, `tests/review/effects.test.ts`, `tests/subagents/sources.test.ts`, `tests/subagents/freshness.test.ts`, `tests/interaction/complete.test.ts`, `tests/tools/spec-gate-behavior.test.ts`, `tests/docs/behavior-change.test.ts`, `tests/decide/records.test.ts`, `tests/e2e/build-flow.test.ts`

**Interfaces:**
- Consumes: `WriteContext.ledger`, `afterLedgerWrite`, `lastForgeRef`.
- Produces: `startComment`, `receiptComment`, `decisionComment` returning `AppendInput`.

- [ ] **Step 1:** Tests (names = scenarios): "Red at pre starts the unit", "Green at pre is refused", "Refactor unit must pass at pre", "Rebuild starts green", "Restart after an amendment", "Parked change refuses", "Resumed unit starts green", "Pending start", "Command not found is not red", "Token redacted everywhere", "Green at post", "Not green at post", "Not started", "Crash between receipt and tick", "Digest changed since start", "Cap reached" (result names three `ledger:<issue>/progress.U1~` refs), "Record fields", "Lane decision in the pull request only"; second machine: `unit_start U2` on a fresh clone whose U1 receipt exists only on `origin` starts U2; "Unknown ledger while offline" at tool level: `unit_start U2` on a fresh clone with `origin` unreachable refuses, runs no `Verify`, writes nothing; `counters.test.ts`: "Counter update edits in place" (second `setCounter` appends, first unchanged, new value read), "Counter shown with cap", the three derived scenarios with `counter` entries; each asserts the entry is in the ledger and no comment of that kind was posted.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Builders return `AppendInput`; add the temporary `decisionBody` and wrap the non-owned call sites with it so they keep posting comments until Tasks 7 and 8; `setCounter(ledger, n, id, value, after?)` appends; `unit_start` and `unit_finish` call `w.ledger.append(n, { ...input, after: lastForgeRef(state.marked) })` then `afterLedgerWrite`; receipt before tick (reconcile unchanged); `start` = start entry `ref`; attempt/receipt lines `ledger:<issue>/<ref>`; `plan-units-steps` appends decisions before the body write; tests that post builder output as comments use `h.seed` or `ledgerRecord`.
- [ ] **Step 4:** `bun run typecheck && bun run test` → PASS.
- [ ] **Step 5:** Commit `feat(ledger): write unit evidence and planning decisions to the ledger`.

---

## Task 7: Subagent and review writers — implements 7

**Covers:** 7.1, 7.2, 7.3, 7.4
**Difficulty:** Hard
**Blocked by:** Task 6 (`decisionComment` and evidence builders change shape in Task 6; serial avoids shared files)

**Files:**
- Modify: `src/subagents/records.ts`, `src/subagents/dispatch.ts`, `src/subagents/run-record.ts`, `src/subagents/resume.ts`, `src/subagents/lane-ops.ts`, `src/review/records.ts`, `src/review/stages.ts`, `src/tools/subagent-request.ts`, `src/tools/subagent-answer.ts`, `src/tools/subagent-record.ts`, `src/tools/subagent-dispatch.ts`, `src/tools/lane-open.ts`, `src/tools/lane-merge.ts`, `src/tools/finding-rebut.ts`, `src/audit/confirm.ts`
- Test: `tests/subagents/dispatch.test.ts`, `tests/subagents/records.test.ts`, `tests/subagents/lanes.test.ts`, `tests/subagents/packet.test.ts`, `tests/subagents/freshness.test.ts`, `tests/tools/subagent-dispatch.test.ts`, `tests/tools/subagent-answer.test.ts`, `tests/tools/subagent-answer-race.test.ts`, `tests/tools/subagent-record.test.ts`, `tests/tools/finding-rebut.test.ts`, `tests/review/stages.test.ts`, `tests/review/effects.test.ts`, `tests/e2e/review-flow.test.ts`, `tests/e2e/subagent-build.test.ts`

**Interfaces:**
- Consumes: `Ledger.append`, `lastForgeRef`.
- Produces: dispatch deps `record(input)`; builders returning `AppendInput`.

- [ ] **Step 1:** Tests: "Marker kind registered" (entry in ledger, no comment), "Discoveries reach the dependent unit", "Audit scout writes no dispatch record", "Retry record is not a result", "Refused resume falls back to one new child" (RETRY entry), "Inline review recorded", "Inline record with an ignored finding", "Unit review recorded", aggregate holds `reviews` as entry refs and `finding-scope` is an entry (drop `decisionBody` at `review/stages.ts`), rebuttal written as an entry; "Ledger append in read-only mode" and "Forge down" at the `Ledger.append` level in `tests/ledger/sync.test.ts` (forge stub unreachable; append succeeds, no `ForgeError`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Builders return `AppendInput`; replace `post` with `record` for these kinds in `recordDeps` (`subagent-request.ts`), `LaneOps` (`lane-open.ts`, `lane-merge.ts`, `subagent-dispatch.ts`), `audit/confirm.ts` (no-op); `dispatch.ts`, `run-record.ts`, `resume.ts`, `lane-ops.ts`, `subagent-answer.ts`, `subagent-record.ts`, `finding-rebut.ts` (write only; its parameter stays until Task 10) and `review/stages.ts` append; `review-run` stays a comment.
- [ ] **Step 4:** `bun run typecheck && bun run test` → PASS.
- [ ] **Step 5:** Commit `feat(ledger): write dispatch and finding records to the ledger`.

---

## Task 8: Completion engine writers — implements 8

**Covers:** 8.1, 8.2, 8.3
**Difficulty:** Normal
**Blocked by:** Task 7 (shares `decisionBody` removal and completion test files with Tasks 6 and 7)

**Files:**
- Modify: `src/interaction/complete-effects.ts`, `src/interaction/complete.ts`, `src/interaction/complete-decide.ts`, `src/interaction/complete-overrides.ts`, `src/interaction/complete-amend.ts`, `src/interaction/complete-gate.ts`, `src/interaction/complete-question.ts`, `src/interaction/complete-stuck.ts`, `src/interaction/requests.ts`, `src/interaction/session-ctx.ts`, `src/interaction/poll.ts`, `src/tools/request-flow.ts`
- Test: `tests/interaction/complete.test.ts`, `tests/interaction/poll.test.ts`, `tests/tools/decide-ask.test.ts`, `tests/tools/spec-gate-behavior.test.ts`, `tests/docs/behavior-change.test.ts`

**Interfaces:**
- Consumes: `CompletionCtx.ledger`.
- Produces: `ApplyFn`/`ResultRecord`, `appendRecord` (Contracts).

- [ ] **Step 1:** Tests: "Decide answer completed by a ledger entry", "Decision result in the ledger", "Answer recorded", "Other refusal asks nothing", "Crash while applying" still passes, a second poll after a completed decide appends nothing.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `ApplyFn` returns `ResultRecord` (gate, question, stuck, amendment applies return `{ comment }` unchanged); the dispatcher posts `{ comment }` or `appendRecord`s `{ entry }`; decide, overrides and amend decisions use `appendRecord`; `requests.ts` completion checks the merged list; `session-ctx.ts` and poll pass `ledger`; delete `decisionBody`.
- [ ] **Step 4:** `bun run typecheck && bun run test` → PASS.
- [ ] **Step 5:** Commit `feat(interaction): record decision results in the ledger`.

---

## Task 9: Markers stop accepting ledger kinds — implements 9

**Covers:** 9.1, 9.2
**Difficulty:** Easy
**Blocked by:** Task 6, Task 7, Task 8

**Files:**
- Modify: `src/forge/markers.ts`, `src/evidence/records.ts`, `src/subagents/records.ts`
- Test: `tests/forge/markers.test.ts`, `tests/forge/contract.ts`, `tests/forge/github.test.ts`, `tests/forge/gitea.test.ts`, `tests/tools/change-sync.test.ts`, `tests/tools/forge-read.test.ts`, `tests/tools/spec-gate.test.ts`, `tests/tools/decide-ask.test.ts`, `tests/review/round.test.ts`, `tests/subagents/helpers.ts`, `tests/engine/comments-cache.test.ts`, `tests/engine/counters.test.ts`, `tests/subagents/sources.test.ts`, `tests/subagents/packet.test.ts`, `tests/e2e/build-flow.test.ts`, `tests/e2e/review-flow.test.ts`, `tests/e2e/subagent-build.test.ts`

- [ ] **Step 1:** Tests: "Ledger kind refused", "Old receipt comment" (one warning `receipt records live in the ledger`), "Written comment shape" with kind `stale`; each e2e flow asserts no own comment of a ledger kind exists and the ledger holds the expected kinds. Move the listed tests' `writeMarked(<ledger kind>, ...)` seeds to `h.seed`/`ledgerRecord`, and switch forge contract/adapter example kinds to `stale`/`gate` (`grep -rn 'writeMarked("\(receipt\|decision\|counter\|dispatch\|finding-summary\|unit-start\)"' tests` must be empty).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Remove the six kinds from `CORE_KINDS`; `registerKind`/`writeMarked` throw for `isLedgerKind`; `filterMarked` drops them with one warning per kind; remove `registerKind(START_KIND)` and `registerKind("dispatch")` module-load calls.
- [ ] **Step 4:** `bun run typecheck && bun run test` → PASS.
- [ ] **Step 5:** Commit `feat(markers): ledger kinds are no longer forge comment kinds`.

---

## Task 10: Public references and packet sources — implements 10

**Covers:** 10.1, 10.2, 10.3, 10.4
**Difficulty:** Normal
**Blocked by:** Task 9

**Files:**
- Modify: `src/subagents/sources-records.ts`, `src/tools/finding-rebut.ts`, `src/tools/subagent-target.ts`, `src/subagents/build-loop.ts`, `src/review/status.ts`, `src/review/records.ts`, `src/review/effects.ts`, `src/subagents/finish-freshness.ts`, `src/subagents/freshness.ts`
- Test: `tests/subagents/sources.test.ts`, `tests/subagents/packet.test.ts`, `tests/subagents/freshness.test.ts`, `tests/tools/finding-rebut.test.ts`, `tests/tools/subagent-dispatch.test.ts`, `tests/review/effects.test.ts`

- [ ] **Step 1:** Tests: "Ledger source" (`ledger:59/dispatch.U1.implementer.0~3fa2c1d0`, same version on rebuild), "Grouped records keep their ids", "Discovery from a dispatch entry", "Own receipt posted", "Comment id refused", "Missed context", "Rebut without evidence", `finding_rebut "501"` on an entry with `from: "501"`, "Verifier recorded" with `finding-summary.change.review.1~a1b2c3d4:0`, `c1:0` refused without a matching `from`, "Question raised once" with `finding:<aggregateRef>:<index>`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Cite ledger records as `ledger:${n}/${m.ref}` with `entryVersion`; rename the `finding_rebut` parameter to `ref` with description "the ref of a finding-summary ledger entry"; `subagent-target.ts` accepts `<ref>:<index>` and its description says so; lookups use `matchesRef`; freshness treats `source: "ledger"` as own.
- [ ] **Step 4:** `bun run typecheck && bun run test` → PASS.
- [ ] **Step 5:** Commit `feat(subagents): cite ledger records as ledger:<issue>/<ref>`.

---

## Task 11: Ship and close — implements 11

**Covers:** 11.1, 11.2, 11.3, 11.4
**Difficulty:** Normal
**Blocked by:** Task 4, Task 9

**Files:**
- Modify: `src/tools/change-ship.ts`, `src/tools/change-close.ts`, `src/ship/close.ts`, `src/config.ts`, `src/commands/doctor-checks.ts`
- Test: `tests/tools/change-ship.test.ts`, `tests/tools/change-close.test.ts`, `tests/config.test.ts`

- [ ] **Step 1:** Tests: "Ledger not pushed" (no branch push, no PR); ship pushes the ledger before the branch; "Close after merge" and "Default keeps the ledger"; "Close deletes the ledger" and "Retain false deletes it"; "Remote delete fails"; retry with no local ref skips the step; "Ledger retention", "Invalid ledger retention".
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `change_ship`: `w.ledger.sync(n)` after the refusal checks, refuse `the ledger could not be pushed: <reason>` unless `synced`; config adds `ledger` to `PROJECT_KEYS` with boolean validation; `change_close` adds the removal step after closing the issue.
- [ ] **Step 4:** `bun run typecheck && bun run test` → PASS.
- [ ] **Step 5:** Commit `feat(ship): push the ledger before shipping and honour ledger.retain at close`.

---

## Task 12: Docs — implements 12

**Covers:** 12.1, 12.2
**Difficulty:** Easy
**Blocked by:** Task 10, Task 11

**Files:**
- Create: `docs/decisions/0008-machine-ledger.md`
- Modify: `docs/decisions/README.md`, `docs/decisions/0002-issue-is-source-of-truth.md`, `docs/architecture.md`, `docs/glossary.md`, `README.md`, `README.vi.md`, `CHANGELOG.md`

- [ ] **Step 1:** ADR 0008: context (#58, #59), decision (D1–D12 in short), consequences (breaking for in-flight changes, trust = push access, accepted guard limits, gate baseline stays on the gate comment until #61).
- [ ] **Step 2:** Architecture (ledger section, forge/ledger record split, packet source forms, accepted limits), glossary (Ledger, Ledger entry), READMEs (`ledger.retain`), CHANGELOG Unreleased (breaking: in-flight changes, `finding_rebut` and verifier references).
- [ ] **Step 3:** `bun run test` and `openspec validate ledger-store --strict` → PASS, 0 errors.
- [ ] **Step 4:** Commit `docs: ADR 0008 machine ledger and architecture update`.

---

## Scenario → test

Test names equal scenario names unless noted. "existing" = present today, must stay green.

**ledger-store**
- First record creates the ref, Shared between worktrees, Two records with the same id, Unknown kind refused, Two local sessions append at once, Dirty tree does not matter, No git identity, Corrupt line, Unknown schema → `tests/ledger/store.test.ts` (Task 2)
- Second machine sees the first machine's records, Unknown ledger while offline (also tool level in `tests/tools/unit-start.test.ts`, Task 6), New change, empty remote, Known ledger while offline, Version kept across a replay, Two machines append concurrently, Remote ledger absent, Offline append, Pending entries pushed later → `tests/ledger/sync.test.ts` (Task 4)
- Receipt before a later rebuild, Unit start after a park, Latest counter after a replay, Reference by migrated comment id → `tests/ledger/merge.test.ts` (Task 5); No ledger → `tests/engine/snapshot.test.ts` (Task 5)
- Forge down → `tests/ledger/sync.test.ts` (Task 7)
- Default keeps the ledger, Retain false deletes it, Remote delete fails → `tests/tools/change-close.test.ts` (Task 11), plumbing in `tests/ledger/sync.test.ts` (Task 4)

**forge-markers**: Ledger kind refused, Old receipt comment, Written comment shape → `tests/forge/markers.test.ts` (Task 9); Registered kind, Unknown kind, Round trip, Foreign marked comment, Own marked comment, Plain comment → existing `tests/forge/markers.test.ts`
**forge-cache**: Ledger append in read-only mode → `tests/ledger/sync.test.ts` (Task 7); Unreachable read, Unreachable write, Not cached → existing `tests/forge/cache.test.ts`
**flow-engine**: Started unit from comments, Done unit is never started, Account switch → `tests/engine/snapshot.test.ts` (Task 5); Counter shown with cap, Derived discovered dependencies, Derived review rounds, Counter update edits in place, Derived unit attempts → `tests/engine/counters.test.ts` (Task 5); State from fixture issue, Stale state, Ambiguous phase, Pending request and lock from comments, Pull request state, Unreadable pull request, Derived iteration count, Comments cache hit, Own write invalidates → existing `tests/engine/snapshot.test.ts`, `tests/engine/comments-cache.test.ts`, `tests/engine/iterations.test.ts`
**approver-adapters**: Decide answer completed by a ledger entry, Decision result in the ledger → `tests/interaction/complete.test.ts` (Task 8); Crash while applying, Foreign marked gate ignored, Forge answer recorded → existing `tests/interaction/complete.test.ts`, `tests/interaction/forge.test.ts`
**decision-seam**: Record fields, Lane decision in the pull request only → `tests/decide/records.test.ts`, `tests/tools/plan-units.test.ts` (Task 6); Large facts hashed, Proposal record is not current, Behavior files kept with hashed facts → existing `tests/decide/records.test.ts`
**durable-doc-checks**: Answer recorded, Other refusal asks nothing → `tests/tools/spec-gate-behavior.test.ts` (Task 8); Always asks, New file asks again, Asked once at define, Changed answer blocks the same call, Flow without the check, Forge request pending → existing `tests/docs/behavior-change.test.ts`, `tests/tools/spec-gate-behavior.test.ts`
**subagent-dispatch**: Marker kind registered, Discoveries reach the dependent unit, Audit scout writes no dispatch record, Retry record is not a result, Refused resume falls back to one new child → `tests/subagents/dispatch.test.ts`, `tests/subagents/records.test.ts` (Task 7); Inline review recorded, Inline record with an ignored finding → `tests/tools/subagent-record.test.ts` (Task 7); Verifier recorded → `tests/tools/subagent-dispatch.test.ts` (Task 10); every other Dispatch tool, Result handling and Questions from a child scenario, No executor, Audit scout not inline → existing `tests/subagents/dispatch.test.ts`, `tests/tools/subagent-dispatch.test.ts`, `tests/tools/subagent-answer.test.ts`, `tests/subagents/in-flight.test.ts`, `tests/tools/subagent-answer-race.test.ts`
**subagent-packets**: Ledger source, Grouped records keep their ids, Discovery from a dispatch entry, Own receipt posted → `tests/subagents/sources.test.ts`, `tests/subagents/packet.test.ts`, `tests/subagents/freshness.test.ts` (Task 10); Same inputs, same hash, Comment edited, New record changes the grouped version, Records do not grow the required list, Implementer answers stay required, Instruction in a comment, New human comment, New answer recorded by the plugin and the other Context manifest scenarios → existing `tests/subagents/packet.test.ts`, `tests/subagents/sources.test.ts`, `tests/subagents/freshness.test.ts`
**review-findings**: Unit review recorded → `tests/review/stages.test.ts` (Task 7); Comment id refused, Missed context, Rebut without evidence → `tests/tools/finding-rebut.test.ts` (Task 10); Rebutted warning, Why of a run kept, Parent-written block names omitted ids, Older summary still valid → existing `tests/tools/finding-rebut.test.ts`, `tests/subagents/records.test.ts`
**finding-routing**: aggregate entry and finding-scope entry → `tests/review/stages.test.ts` (Task 7); Question raised once → `tests/review/effects.test.ts` (Task 10); Two reviewers, one defect, Same file, other line, Reviewer still missing, the Finding scope rule scenarios, Unit unticked, Out of scope does not block, No pull request and the review-comment scenarios → existing `tests/review/*.test.ts`
**review-phase**: Auth file without a security tag, Cap reached, Last round finishes before the cap, Stuck answer restarts the budget → existing `tests/review/*.test.ts`
**discovered-dependencies**: Counter shown, Cap exceeded, Option D does not count → existing `tests/engine/deps-facts.test.ts`, `tests/tools/new-dependency.test.ts`
**unit-evidence**: Red at pre starts the unit, Green at pre is refused, Refactor unit must pass at pre, Rebuild starts green, Restart after an amendment, Parked change refuses, Resumed unit starts green, Pending start, Command not found is not red, Token redacted everywhere, Green at post, Not green at post, Not started, Crash between receipt and tick, Digest changed since start, Cap reached → `tests/tools/unit-start.test.ts`, `tests/tools/unit-finish.test.ts` (Task 6); other Unit start, Unit finish, Receipt, Valid red, Verifier pending and attempts scenarios → existing `tests/tools/unit-*.test.ts`, `tests/tools/unit-finish-findings.test.ts`, `tests/evidence/*.test.ts`
**parallel-lanes**: Lane created → existing `tests/tools/lane-tools.test.ts`
**drift-audit**: Renamed test refuted, Scout sees the audited snapshot, Seeded audit with a confirming scout, No executor, Launch mismatch → existing `tests/audit/*.test.ts`, `tests/e2e/audit-flow.test.ts`
**change-close**: Close after merge, Close deletes the ledger → `tests/tools/change-close.test.ts` (Task 11); Not merged, Last change of an initiative, Retry after a partial close, Retry after the initiative closed → existing `tests/tools/change-close.test.ts`
**ship-phase**: Ledger not pushed → `tests/tools/change-ship.test.ts` (Task 11); every other Ship tool scenario → existing `tests/tools/change-ship.test.ts`, `tests/ship/ship-refusals.test.ts`
**command-guards**: No tool calls the push path, Ledger push refspec, Ledger operations refuse a bad issue number → `tests/guard/push-callers.test.ts` (Task 3); Agent ledger writes blocked, Agent ledger reads allowed → `tests/guard/classify.test.ts` (Task 3); Refspec from the issue, Refspec from the fix branch, Refspec of a wip branch, Delete of a wip branch, Delete refuses a non-wip branch → existing `tests/guard/push-callers.test.ts`
**init-and-doctor**: Ledger retention, Invalid ledger retention → `tests/config.test.ts` (Task 11); other Config files scenarios → existing `tests/config.test.ts`
