## 1. Shell parser and command guard classifier

Blocked by: none

- [x] 1.1 Add `src/guard/shell.ts`: a pure POSIX-shell tokenizer and simple-command splitter. It handles quotes, escapes, comments, `;` `&&` `||` `|` `&` and newlines, subshells and groups, redirections with targets, and `$(…)` and backtick substitutions kept as nested scripts. Commands stay in source order, and unbalanced input returns `unreadable`
- [x] 1.2 Add wrapper unwrapping (assignments, `env`, `command`, `exec`, `nice`, `nohup`, `time`, `timeout`, `sudo`, `xargs`, `sh|bash|zsh|dash -c`, `git` global options) with a depth limit of 8
- [x] 1.3 Add `src/guard/classify.ts` `classifyCommand(command, ctx)` and `forgeEndpoints`, covering the design D7 rules: push and aliases, `gh`, `tea`, `curl`/`wget` against forge endpoints, and obscured forms with dangerous tokens. Every block reason starts with `livespec guard:` and names the tool to use
- [x] 1.4 Add `src/guard/paths.ts` and the write-target rule. It applies to `write`/`edit` paths and to bash write targets: redirects, `tee`, `cp`, `mv`, `rm`, `ln`, `touch`, `install`, `sed -i` and `perl -i`. It resolves `..` and existing symlinks, and tracks `cd`/`pushd` within one command
- [x] 1.5 Table tests in `tests/guard/` naming every command-guards classification scenario, plus the Review Focus bypass and false-positive cases

## 2. Evidence records, unit state and the progress rule

Blocked by: none

- [x] 2.1 Add `src/evidence/records.ts`: register kind `unit-start`, and build and parse the `unit-start` and `receipt` data (design D2) with their marker ids
- [x] 2.2 Add `src/evidence/signature.ts`: failing test names (vitest/jest, go test, pytest, TAP) and the normalized sha256 hash
- [x] 2.3 Add `src/evidence/progress-rule.ts`, the `progressRecord` builder, and `progress` in `registerBuiltinRules`. Add the optional `signature` and `attempt` fields to `DecisionRecord` and keep them in `compactFacts`
- [x] 2.4 Add `src/evidence/unit-state.ts` `deriveUnitEvidence(change, marked, cap)`, which gives started, receipts, attempts, blocked with a reason, and unticked receipts. Export `liftsCap` from `src/engine/iterations.ts` and reuse it
- [x] 2.5 Add `src/evidence/pending.ts`: test-file patterns, the pending decision, and the test-only commit check over git facts
- [x] 2.6 Unit tests for each pure module

## 3. Verify runner, temporary worktrees, run classification, Git additions and config

Blocked by: none

- [x] 3.1 Add `verify.setup` and `verify.timeout` to `ProjectConfig` in `src/config.ts`, with warnings and defaults
- [x] 3.2 Add `Git.worktreeAdd`, `worktreeRemove`, `worktreePrune`, `revList`, `pathExistsAt`, `changedPaths`, `isIgnored` and `aliases` in `src/engine/git.ts`
- [x] 3.3 Add `src/evidence/output.ts` `outputTail` (8 KB budget including the truncation mark, UTF-8 boundary, invalid bytes replaced) and `src/evidence/runner.ts` `runVerify`. The runner checks the injected guard before spawning, runs `/bin/sh -c` in a cwd with stdin closed, kills the process group on timeout or abort, keeps the output tail with the total byte count, and redacts tokens
- [x] 3.4 Add `src/evidence/red-green.ts` (classify a run; the pre and post expectations for normal and refactor units)
- [x] 3.5 Add `src/evidence/worktree.ts` `withTempWorktree(git, root, sha, prep, fn)`. It prunes first, prepares with the setup command or dependency symlinks, honors abort, and always removes the worktree
- [x] 3.6 Tests against real temporary git repositories (`tests/helpers/repo.ts`), including timeout, abort, output edge cases and the symlink case

## 4. Engine integration: state, counters, next step, gate-only checks, card

Blocked by: 2

- [x] 4.1 Extend `ChangeState` with `evidence` and `issue.url`, and change `incomplete` to the items of the latest `incomplete` comment. Thread `unitAttemptsCap` through `deriveCommentFacts`, `SnapshotDeps`, `src/hooks/card-input.ts` and `src/interaction/complete-validate.ts`. Expose `unit_attempts.<unit>` in `counters`, and ignore `counter` comments for it
- [x] 4.2 Extend `NextStep` with `startedUnits`, `blockedUnits` (with reason) and `pendingVerifier`, rename the `Depends` list to `waitingUnits`, and add precedence rules 10–12 in `src/engine/next-step.ts`. Update `src/hooks/phase-card.ts`, `src/tools/format-step.ts` and the test fixtures that use the old name
- [x] 4.3 Add `registerCheck(…, { at: "gate", key })`, the per-check keyed memo in `src/engine/registry.ts`, and `runChecks(…, { gate: true, target })` in `src/engine/checks.ts`
- [x] 4.4 Add `src/evidence/card.ts`, the `evidence` card section: started with its pre SHA, blocked with its reason, verifier pending
- [x] 4.5 Tests for the flow-engine and context-injection delta scenarios

## 5. Unit start and unit finish tools

Blocked by: 1, 2, 3, 4

- [x] 5.1 Add `src/evidence/refusals.ts`: pure `unitStartRefusal`, `unitFinishRefusal` and `finishMode`, in design D10 order, covering both the reconcile and the run branch
- [x] 5.2 Add `src/evidence/verify-env.ts` `verifyEnv(session)`, which gives the guard, tokens, endpoints, aliases, git, root and config. Add `Session.redactionTokens()`, `forgeTarget()`, a session abort signal that `session_shutdown` aborts, and `drainEvidence()`, which the shutdown handler awaits so cleanup finishes first, in `src/hooks/session.ts`. Add `src/evidence/lock.ts` `withEvidenceLock`
- [x] 5.3 Add `src/tools/unit-start.ts`: lock, refresh, refusal, pending decision, pre run and classification, then the `unit-start` comment
- [x] 5.4 Add `src/tools/unit-finish.ts`. Under the lock: refresh, `finishMode` and refusal; the reconcile-only tick; the pending-commit check; the post run; the receipt, then a version-checked tick that handles a conflict; the failed attempt as a `progressRecord`; the blocked result with links
- [x] 5.5 Register both tools in `src/tools/change-tools.ts`, with only a `unit` parameter
- [x] 5.6 Tool tests over `MemoryWorld` and real git repositories for every scenario of the start, finish, receipt, valid-red, pending and attempts requirements, plus the decision-seam end-to-end, concurrency, conflict and abort cases

## 6. Verify-red-on-base check, spec_gate and the default pack

Blocked by: 3, 4, 5

- [ ] 6.1 Add `src/evidence/red-on-base.ts`: the gate-only, waivable check over `withTempWorktree` at `Base`, with an internal per-`(root, Base, unit, digest)` cache, its environment set by `setRedOnBaseEnv`, and an error when no environment exists. `clearGateMemo()` runs at `session_start` and `session_shutdown`
- [ ] 6.2 Make `spec_gate` run `runChecks(…, { gate: true, target })` before `gateRefusal`. Answer validation keeps using memoized results only
- [ ] 6.3 Add `verify-red-on-base` and `decisions.progress` to `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json`
- [ ] 6.4 Tests for the verify-red-on-base, phase-gates and flow-pack delta scenarios

## 7. Work-in-progress predicate

Blocked by: 2

- [x] 7.1 Add `src/evidence/wip.ts`, which registers a predicate over open `build` changes' own marked comments via `deriveUnitEvidence`
- [x] 7.2 Tests for the work-in-progress and agent-skills-content delta scenarios

## 8. Guard and settle hooks, wiring and docs

Blocked by: 1, 4, 5, 6, 7

- [ ] 8.1 Add `src/guard/push.ts` `guardedPush`, unused by tools, and a test that no file under `src/tools/` imports it
- [ ] 8.2 Add `src/hooks/guard.ts`: the `tool_call` handler for `bash`, `write` and `edit`, with forge endpoints and git aliases from the session. It fails closed and is registered before the context hook. Make `tests/hooks/fake-pi.ts` stop at a blocking `tool_call` result, as pi does
- [ ] 8.3 Add `src/hooks/settle.ts`: `agent_before_settle` and `agent_settled`, `registerSettleCondition`, one continuation, the `incomplete` comment written and cleared in place in every phase, and read-only handling
- [ ] 8.4 Wire the hooks, tools, rule, card, check and predicate in `src/extension.ts`
- [ ] 8.5 Hook tests with `tests/hooks/fake-pi.ts` for every command-guards hook scenario and every settle-continuation scenario, plus an end-to-end build test: start red, finish green, receipt, tick, a blocked `gh issue edit` and a blocked `git push`
- [ ] 8.6 Update `docs/architecture.md`: evidence, guards, settle, the accepted limits (script files, pushes outside pi, executors without the extension), and the two closed known gaps
