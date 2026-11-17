# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `unit-evidence-and-guards`
**Iteration**: `3`
**Applied at**: `2026-11-17 16:04`
**Executor**: `subagent-driven-development`. Implementer seats used the `implementer` agent, and task and final reviews used the `code-reviewer` agent. Models came from the agent config, with no override.

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.unit-evidence-and-guards`
- **Worktree branch**: `unit-evidence-and-guards`
- **Feature branch**: `ls-06`
- **Base branch**: `main`

---

## Commits

- **Range**: `af3e9f6..bd4fe09`. This covers the lane merges, the `tasks.md` ticks, the final-review fix wave, every verify and apply receipt, and the iteration-2 and iteration-3 fixes. The `apply.md` commit itself comes after `bd4fe09`.
- **Count**: `58`
- **Iteration 3 range**: `878d376..bd4fe09`, 4 commits. This fixed verify iteration 2 (FAIL).
  - `940fc00`: fixes the guard.
  - `47de3b7`: stabilises the suite.
  - `5c98b77` and `bd4fe09`: a scratch report was force-added, then untracked again. Their net effect on tracked files is nil.
- **Iteration 2 range**: `a1039d7..71d000e`, 5 commits. This fixed verify iteration 1 (FAIL): `95fc76f`, `8a44a22`, `e084548`, `3faa8e4`, `71d000e`.

---

## Tasks

- **Completed**: `40 of 40` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

---

## Contract deviations

These are all internal contracts (`public: no`) unless noted. No public contract changed and no dependency was added.

- `withEvidenceLock`: the shape changed from `withEvidenceLock(issue, fn)` to `withEvidenceLock(fn)`, one per-session chain. A key read from the card before the refresh let two calls decide from the same state (ruling 8). `lock.ts` also exports `drainEvidenceLocks`.
- `Session`:
  - gains `setRedactionTokens` and `abortEvidence`, needed by the lifecycle and token handling;
  - `clearGateMemo()` runs inside the hooks' error boundary.
- `src/tools/unit-tool.ts`: a new shared shell for both unit tools, holding the lock, cancellation (`UnitCall.cancelled()`) and the result text, so the two tools do not duplicate orchestration.
- `refusals.ts`:
  - adds `refactorPendingRefusal` and `blockedRefusal(state, unit)`, needed to keep I/O out of the pure decider and to link evidence;
  - adds a `stale` rule to the start and run rules.
- `RECEIPT_OUTPUT_BYTES`: lives in `src/evidence/verify-env.ts`.
- `testOnlyCommitCheck`: gains a third parameter (the pending test files) and a `missing` result, so a commit that touches no pending test is refused.
- `Git.parents()`: added to refuse a merge commit as the pending first commit.
- `stripWrappers`: may return `{ script }`, for `env -S` and `flock -c`.
- Iteration 3 changes:
  - `checkChildScript` (`src/guard/classify.ts`) now blocks an expansion child script when its decoded text mentions livespec, as well as when it has a dangerous token. This covers `env -S`, `sh -c` and `flock -c`.
  - Test infra: `vitest.config.ts` sets `testTimeout` and `hookTimeout` to 30_000. Temp-dir cleanup retries (`maxRetries` 5). The `pgrep` markers in `tests/evidence/runner.test.ts` are unique per run.
- Iteration 2 changes:
  - `src/guard/unwrap.ts` gains a pure env split-string splitter.
  - An unreadable `-S` value is decoded (`\_`, `\t`, `\n` become spaces) before the dangerous-token scan, and fails closed.
  - `flock` options after the lock file are scanned.
  - `src/guard/paths.ts` `optionArgument` recognises attached short values (`-tDIR`) and stops at `--`.
  - `checkChildScript` in `src/guard/classify.ts` scans the decoded expansion script with `nestedScan`.
- `budgetWindow`: exported from `src/evidence/unit-state.ts`, one shared budget window for the unit state and `unit_finish`.
- `settleItems`: takes `(state, pack)`, because it needs the pack to tell a `per: unit` phase.
- `registerCheck`/registry: the registry gains the internal helpers `gateKey`, `storeGateResults` and `storedGateResults`. `red-on-base.ts` exports `registerRedOnBase`, registered from `registerBuiltinChecks`.
- `src/guard/classify.ts`: split into `options.ts`, `unwrap.ts` and `rules.ts` under ruling 2. `classifyCommand` and `forgeEndpoints` are unchanged.
- Test harness: `toolHarness` gains the `locked` and `change` options and a `signal` argument on `call`. `tests/hooks/fake-pi.ts` stops at a blocking `tool_call` result, as pi does.
- `outputTail`, `StreamRedactor`, `asStartRecord`/`asReceiptRecord`, `KILL_GRACE_MS`, `DEFAULT_VERIFY_TIMEOUT_S`, `UNWRAP_DEPTH` and the named types `VerifyConfig`, `WorktreeFailure`, `ProgressOutcome` and `ProgressInput`: extra exports and names, with the shapes as in Contracts.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | `unit-evidence-and-guards--task-1` | `af3e9f6..a517a7b` | approved after 2 fix rounds | `8655f65` |
| 2 | `unit-evidence-and-guards--task-2` | `af3e9f6..cb9f6af` | approved after 1 fix round | `2fc07aa` |
| 3 | `unit-evidence-and-guards--task-3` | `af3e9f6..2dd8bd5` | approved after 3 fix rounds | `1054347` |
| 4 | `unit-evidence-and-guards--task-4` | `8b3627f..c1d2228` | approved after 1 fix round | `fdc036c` |
| 5 | `unit-evidence-and-guards--task-5` | `f0f07cd..17599bb` | approved after 2 fix rounds | `b4008a1` |
| 6 | `unit-evidence-and-guards--task-6` | `b4008a1..0c1ec3a` | approved after 2 fix rounds | `37cc8bb` |
| 7 | `unit-evidence-and-guards--task-7` | `8b3627f..f2697a2` | approved | `a538792` |
| 8 | `unit-evidence-and-guards--task-8` | `7036200..d444bf5` | approved after 1 fix round | `e3f2668` |

Iteration 2 (fix iteration after verify iteration 1 FAIL):

| Item | Lane | Range | Review | Merge commit |
|---|---|---|---|---|
| CRITICAL 1 (`env -S`), WARNINGs 1–3 | `sequential` | `a1039d7..71d000e` | approved after 2 rounds (scoped re-review `af9f2539`) | — (committed on `unit-evidence-and-guards`) |

Iteration 3 (fix iteration after verify iteration 2 FAIL):

| Item | Lane | Range | Review | Merge commit |
|---|---|---|---|---|
| CRITICAL 1 (`env -S` expansion with a livespec path), CRITICAL 2 (suite stability under load), SUGGESTION (pgrep marker) | `sequential` | `878d376..bd4fe09` | approved, 1 round (scoped re-review `fa735f56`) | — (committed on `unit-evidence-and-guards`) |

Final whole-branch review: **With fixes**, with 2 Important and 6 Minor findings. One fix wave followed on `unit-evidence-and-guards` (`4b4c771..d18db6d`, sequential). The scoped re-review found I1 and M3–M7 addressed. It left three guard gaps open: `env -S` split-string escapes, `flock` options after the lock operand, and an attached `mv -tDIR .pi`. Verify iteration 1 reported them, and iteration 2 closed all three.

Integration evidence on `bd4fe09`, from the controller at 16:02–16:04:
- `bun run typecheck` exited 0.
- `bun run test` passed twice in a row. Both runs exited 0, with 136 files and 1949 tests passed. Load averages were 32 for the first run and 106 for the second.

---

## Next step

Run `/opsx-verify` (iteration 3).
