# Apply Receipt

**Change**: `engine-and-content`
**Iteration**: `1`
**Applied at**: `2026-11-15T09:42:20+0700`
**Executor**: `subagent-driven-development`
- **Agents:** `implementer` writes each task; `code-reviewer` (read-only tools) reviews it.
- **Review cycle:** one combined spec-and-quality review after each task, scoped re-reviews after each fix round, then one whole-branch review with a single fix wave.

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.engine-and-content`
- **Worktree branch**: `engine-and-content`
- **Feature branch**: `ls-04`, checked out before step 0. Step 0 committed the change directory there as `0004915`, and the worktree was created from it with `wt switch -c engine-and-content -b ls-04 --no-cd`.
- **Base branch**: `main`

---

## Commits

- **Range**: `0004915..HEAD`
  - `0004915` is the scaffold commit of the change directory on `ls-04`.
  - HEAD is the parent of this receipt, `a7f9e7f`; the receipt itself is committed after it.
- **Count**: `43` commits up to `a7f9e7f`, with no merge commits (all tasks ran sequentially).

---

## Tasks

- **Completed**: `36 of 36` checkboxes in `tasks.md` flipped to `- [x]`
- **Remaining**: none

**Final state:**
- `bun run typecheck` is clean.
- `bun run test` passes 1004 tests in 69 files.
- `openspec validate engine-and-content --strict` is valid.
- `package.json` `dependencies` is still exactly `yaml`.

**Manual cache smoke:** recorded in `smoke.md`.
- Passed on `cmc/claude-haiku-5-5`, `cx/gpt-5.6-luna`, `gpt-6-luna` and `cx/gpt-6-luna`.
- Failed on `cmc/gpt-5.6-luna`. The user ruled this a route issue and named `gpt-6-luna` as the route in use.

**E2E check after the final fix wave:** a real pi session (`9router/gpt-6-luna`, scratch home, livespec loaded with `-e`, payloads logged at `before_provider_request`).
- Only the first request's card carries the `specs/product.md` pointer.
- `cacheRead` grows 1920 → 2176 over 7 turns.

---

## Contract deviations

### Public (each decided by the user in the Inbox thread `engine-and-content`)

- **`runChecks`, `ChangeState.checks`, `NextStep.checks`:** the element type changed from `Result` to `CheckResult = Result & { check: string }`.
  - Reason: the next-step sentence must name the check (`Fix spec-format: …`), and a `Result` only carries its `code`.
  - The change is additive for readers. Code that builds a `ChangeState` by hand must set `check`.
  - User decision during Task 4.
- **`CardInput`:** new variant `{ kind: "change-error"; message: string }`.
  - Reason: `resolveChange` can fail, for example when two open issues claim the same branch.
  - The card header reads `livespec · change not resolved`, with the reason wrapped as untrusted.
  - User decision during Task 7.
- **Phase card message:** now carries `timestamp: 0`.
  - Reason: pi's message type requires the field, and a constant keeps the card byte-identical.
  - User decision during Task 7.

### Internal (recorded in `plan.md` or in the task reports)

- **Task 1 (flow pack):**
  - `getPackSchema` in `registry.ts`.
  - `pack-merge.ts` exports `standalonePack`, `ParsedPack`, `Origin` and `Merged`.
  - `loadPack` reads the default pack through `deps.readFile`.
  - `defaultPackPath` and `DEFAULT_PACK_FILE` were exported in the final fix, so the pack path is resolved with `fileURLToPath`.
- **Task 2 (section helpers):**
  - The only allowed change outside the written region is the single unterminated final line gaining the body's EOL when new lines must follow it. This is documented on `replaceSection` and `setHeaderLine`.
- **Task 4 (engine):**
  - Extra exports: `phaseFromLabels`, `planMove` and `GitError`.
  - `CommentsCache.dir` is the per-repository folder.
  - Every git call that takes a ref, branch, remote or config key from a caller now puts `--end-of-options` first. This followed a real option-injection finding.
- **Task 5 (agent-skills content):**
  - New modules: `pack-skills.ts`, `tree.ts`, `skill-diff.ts`, `root-lock.ts` and `temp-name.ts`.
  - `upgradeGate` and `ContentManagerDeps.lock` were added.
  - `unpin()` rejects with a "busy" error when the root lock cannot be taken in time.
- **Task 6 (init, doctor, skills):**
  - New module `messages.ts`.
  - Extra exports: `resetDoctorChecksForTests`, `formatOutcome` and `SKILLS_USAGE`.
  - Doctor reads the lock with `readLock`, which is read-only.
- **Task 7 (context injection, resume):**
  - `Session` has more fields than the internal contract listed.
  - The resume card is UI-only, shown through `resume-entry.ts`: `pi.appendEntry("livespec-resume")` plus an entry renderer that uses the host-provided `@earendil-works/pi-tui` `Text`.
  - `registerSessionHooks` registers that renderer.
  - In the final fix, the `context` hook, not `session_start`, marks the first card as shown.
- **Task 8 (tools):**
  - New modules: `change-tools.ts`, `read-change.ts`, `spec-write-rules.ts` and `tests/tools/helpers.ts`.
  - Tool `details` fields may be absent on refusal results.
- **Task 9 (wiring):**
  - `extension(pi, deps?)` gained an optional parameter for tests.
  - `defaultSessionDeps` is exported.
  - New modules: `subcommands.ts` and `deps.ts`.
- **Final fix wave:**
  - `isUnreachable` and `isOffline` live in `src/forge/errors.ts`; they are not exported from the barrel.
  - `messageOf` moved to `src/core/messages.ts`, and `src/commands/messages.ts` re-exports it.
  - A throwing registered check becomes a `check-failed` result.
  - A `loadPack` throw becomes a synthetic `PackError`.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | sequential | `0004915..f035531` | APPROVED after 1 fix round | n/a |
| 2 | sequential | `f5cce31..8d8ca5a` | APPROVED after 1 fix round | n/a |
| 3 | sequential | `d176200..183a7c3` | APPROVED after 1 fix round | n/a |
| 4 | sequential | `0edafae..8f36833` | APPROVED after 1 fix round plus one minor fix | n/a |
| 5 | sequential | `12d12d0..2f30e45` | APPROVED after 1 fix round | n/a |
| 6 | sequential | `da8c1e3..d386174` | APPROVED after 1 fix round | n/a |
| 7 | sequential | `2056297..7c1a8c7` | APPROVED after 2 fix rounds | n/a |
| 8 | sequential | `3248655..bffd6b3` | APPROVED after 1 fix round | n/a |
| 9 | sequential | `12a4c43..2d4dbad` | APPROVED after 1 fix round. The smoke (9.4) was run by the parent: `936a3d5`, `c9a2087`, `a95a2c7` | n/a |

**Whole-branch review** of `0004915..a95a2c7`: "With fixes", with 2 Important and 4 Minor findings.
- **Fix wave:** `aedf584` and `a7f9e7f` fix all six.
- **Scoped re-review:** every finding addressed, no new Critical or Important breakage.

Tasks ran one after another in the single worktree, as a pre-flight ruling decided.

---

## Known limits kept

- **`cmc/gpt-5.6-luna` cache:** the appended phase card stops incremental caching on this route (see `smoke.md`). The user attributed this to the route.
- **Root lock:**
  - **Stale-reaper race:** `clearStaleReaper` has a check-then-act race. It needs three or more contenders after a reaper crashed.
  - **No heartbeat:** a critical section longer than 10 minutes can be taken over.
  - **Hidden error:** a `release()` error can mask the error of `fn`.
- **Work-in-progress approximation:** any open change in `build` with a pending unit blocks upgrades, including `update` and `pin`. LS-06 replaces this with the exact unit-started signal.
- **Platform:** v1 is macOS and Linux only; `current` is a symlink.
- **Init after `/livespec init`:** livespec only starts in the current session after `/reload`.
- **Deferred minors from the reviews:**
  - The synthetic `PackError` always names the default pack file, even when the override failed.
  - Inline copies of `messageOf` remain in `forge/detect.ts`, `forge/gitea-transport.ts`, `commands/validate.ts` and `engine/pack-load.ts`.
  - Init reports "kept" when a target path exists as a directory.
  - The `<5s` timing assertion in `tests/hooks/harness.test.ts` may be flaky on slow CI.

---

## Next step

Run `/opsx-verify`.
