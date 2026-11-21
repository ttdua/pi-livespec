## 1. Config, git and decision ports

Blocked by: none

- [x] 1.1 `testCommand` in `ProjectConfig` and `PROJECT_KEYS` of `src/config.ts`, a non-string is a warning and ignored; tests in `tests/config.test.ts` (init-and-doctor "Config files": "Test command", "Invalid test command")
- [x] 1.2 Add `diffNumstat(from, to)` (path, added, deleted; binary → 0/0 with `binary: true`), `showFile(rev, path)` (undefined when missing), `renameBranch(from, to)`, `isTracked(path)` and `subjects(from, to)` to `Git` in `src/engine/git.ts`, with tests on a real temporary repo in `tests/engine/`
- [x] 1.3 Export `livingSpecs` from `src/ship/context.ts` and `capOf` from `src/core/capabilities-diff.ts` (no behavior change)

## 2. Lane rule

Blocked by: 1

- [x] 2.1 `src/fix/branch.ts`: `fixSlug(branch)` (kebab-case `fix/<slug>` or undefined) and `fixMergeBase(git, integration)` (fetch, then merge base with `origin/<integration>`) (small-fix-lane "Fix branch")
- [x] 2.2 `src/fix/lane-facts.ts`: `laneFacts` from numstat, `showFile` at the merge base and HEAD with `parseSpec`, created capability directories, governance paths and capability code (design D2)
- [x] 2.3 `src/fix/lane.ts`: the pure `lane` rule, `laneSchema` (`mode`, positive integer `max_files`/`max_lines`), `laneRuleFn`; registered in `registerBuiltinRules` (small-fix-lane "Lane rule", "Declared no behavior change"); tests in `tests/fix/lane.test.ts`, one per scenario
- [x] 2.4 Change the unknown-point example in `tests/decide/registry.test.ts` from `lane` to `nope` (decision-seam "Rule registry and pack config")
- [x] 2.5 Default pack `decisions.lane: { mode: rule, max_files: 3, max_lines: 100 }` in `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json`; project-override merge and invalid-limit tests (flow-pack "Default flow pack"; small-fix-lane "Project override", "Invalid limit")

## 3. Fix start

Blocked by: 2

- [x] 3.1 `src/tools/fix-start.ts`, registered in `src/tools/change-tools.ts` with the tool-name lists in `tests/extension.test.ts` and `tests/tools/register.test.ts`: refusals then fetch, `switchCreate fix/<slug>` at `origin/<integration>`; never pushes; tests in `tests/tools/fix-start.test.ts` (small-fix-lane "Fix start tool")

## 4. Fix ship

Blocked by: 2, 3

- [x] 4.1 `src/fix/pr-body.ts`: title and body with commit subjects, `## Test`, the `lane` decision block via `formatDecisionBlock`, `neutralizeClosing` outside the block; round-trip test with `parseDecisionBlocks` (small-fix-lane "Fix pull request body")
- [x] 4.2 `src/tools/fix-ship.ts`, registered in `src/tools/change-tools.ts` (and the two tool-name test lists): refusals in spec order under `withEvidenceLock`, `testCommand` through `runVerify`/`verifyEnv`, `guardedPush` with `HEAD:refs/heads/fix/<slug>`, create or update the one pull request (small-fix-lane "Fix ship tool")
- [x] 4.3 Allow `fix-ship.ts` in `tests/guard/push-callers.test.ts` and add the fix refspec test (command-guards "Guarded push")
- [x] 4.4 Tool tests in `tests/tools/fix-ship.test.ts` against the memory forge and a real origin: ship, forced refusal, failing tests, no `testCommand`, nothing to ship, foreign pull request, rerun updates the pull request, no `decision` comment written

## 5. Move a fix into a change

Blocked by: 2

- [x] 5.1 `from_fix` parameter of `change_new` in `src/tools/change-new.ts`: refusals, issue in `define` with `Branch`, `Base` and seeded Proposal, then `renameBranch` and `livespecBase` config; failure messages name the issue and the remaining step (small-fix-lane "Move a fix into a change"; change-tools "Change new tool")
- [x] 5.2 Tests in `tests/tools/change-new.test.ts`, including the Done-when path: a fix adding a requirement is refused by `fix_ship`, then `change_new --from-fix` keeps HEAD and the card resolves the change in `define`

## 6. Fix card

Blocked by: 2

- [x] 6.1 `fixCardInput` in `src/hooks/card-input.ts`: `{ kind: "fix", slug, outcome | error | empty }` on a fix branch before `resolveChange`; `src/hooks/phase-card.ts` renders it with exactly one next step and no subagent step (small-fix-lane "Fix card"; context-injection "Resume at session start"; subagent-policy "Small-fix lane")
- [x] 6.2 `spec_status`, `spec_next` and `/livespec next` return the fix step on a fix branch through the same builder (change-tools "Status and next tools")
- [x] 6.3 Tests in `tests/hooks/card-input.test.ts`, `tests/hooks/phase-card.test.ts`, `tests/hooks/session.test.ts` (fix branch at session start) and the `spec_next` tool test

## 7. Bare work

Blocked by: 1, 2

- [x] 7.1 `src/guard/bare-work.ts`: `isBareWork` (branch, inside project, not `specs/` or `.pi/livespec/`, tracked) and `appendBareWork` (once per path per date, serialized, never throws) (command-guards "Bare work")
- [x] 7.2 `src/hooks/guard.ts`: call it from `checkPath` for `write`/`edit`, keep the warning by `toolCallId`, and a `tool_result` handler that appends it; skipped in child sessions and uninitialized projects
- [x] 7.3 Tests in `tests/hooks/guard.test.ts`: edit on main logged, once per day, not bare work on fix/change branches, under `specs/`, or for untracked files; log failure still allows the call and says the work was not logged; child session gets no log and no warning

## 8. Docs and end-to-end check

Blocked by: 3, 4, 5, 6, 7

- [ ] 8.1 `docs/architecture.md`: small-fix lane (tools, `lane` rule, decision block, `declared-none`) and bare work, including the `bash` limit; update the header comment of `src/guard/push.ts`
- [ ] 8.2 Run `bun run typecheck` and `bun run test`, then run the Done-when scenario end to end through the tool harness
