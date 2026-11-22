## Context

LS-09a left the pieces the lane reuses: `guardedPush` (`src/guard/push.ts`), `changeDiff` from the merge base (`src/ship/diff.ts`), living-spec `paths` reading (`src/ship/context.ts` `livingSpecs`), `neutralizeClosing` (`src/ship/pr-body.ts`), `runVerify` with the guard and redaction (`src/evidence/runner.ts`, `verify-env.ts`), `formatDecisionBlock` / `parseDecisionBlocks` (`src/decide/records.ts`), `parseSpec` (`src/core/spec.ts`) and `parseBareWork` (`src/core/bare-work.ts`). A fix branch has no issue, so nothing here can use `ChangeState`, the snapshot, gates or marked comments; the lane's state is git plus the forge's pull requests only.

## Goals / Non-Goals

**Goals:** the brainstorm's goals, built as a separate `src/fix/` module that depends on `src/core`, `src/engine/git.ts`, `src/decide` and `src/ship` helpers, never the reverse.

**Non-Goals:** the brainstorm's non-goals. No change to `nextStep` or the change snapshot: the fix card is a separate card kind.

## Decisions

**D1. A fix is identified by its branch only.** `fix/<slug>` with `<slug>` kebab-case (`isKebabName`) is a fix branch; nothing is stored in git config or on the forge. `fix_start` refuses a non-kebab slug, a dirty tree, an existing local `fix/<slug>`, an unknown integration branch, and a call while on a `livespec/*` branch. *Alternative:* a `branch.<b>.livespecFix` config key like `livespecBase`. Rejected: the merge base gives the starting point already, and a hand-made `fix/x` branch should work the same.

**D2. Lane facts are built by code, the rule is pure.** `laneFacts(git, root, integration)` fetches the integration branch, takes `M = merge-base(HEAD, origin/<integration>)` and builds:
- `files` and `lines` from a new `git.diffNumstat(M, "HEAD")` (`diff --numstat -z -M`, so a rename is one record with its new path; added + deleted; `-` for binary counts 0 lines);
- `specChanges`: for each changed `specs/<cap>/spec.md`, `parseSpec` of `git show M:<path>` (missing → none) and of the work tree file at HEAD (`git show HEAD:<path>`, so uncommitted edits do not count); added and removed requirement names, and per surviving requirement added and removed scenario names;
- `createdCapabilities`: `specs/<cap>` present at HEAD and absent at `M` by the existing `git.pathExistsAt` (reusing the `capOf` rule of `capabilities-diff.ts`, exported);
- `governance`: changed paths equal to `specs/constraints.md` or under `specs/decisions/`;
- `capabilityCode`: changed non-spec files matched by a living spec's `paths` (`livingSpecs`, exported from `src/ship/context.ts`), with whether that capability's spec file changed.

The `lane` rule (`registerRule("lane", laneSchema, laneRuleFn)`) returns the outcome map `{ lane: "small" | "forced", reasons, behavior_change?: "declared-none", capabilities? }` (snake_case because it is written verbatim into the YAML block); it never asks. A rename counts as one file (numstat reports the new path). Its schema accepts `mode`, `max_files` and `max_lines` (positive integers); a project override merges with the one-level spread. *Alternative:* text diff of `### Requirement:` lines. Rejected: `parseSpec` already handles fences and is the format's single source.

**D3. `fix_ship` order** (all under the evidence lock, so two calls cannot open two pull requests):
1. on a fix branch, not a child session (`childRefusal`), forge writable, tree clean;
2. fetch and merge base succeed, and `subjects(M, HEAD)` is not empty (an empty or already merged fix has nothing to ship);
3. lane facts, then `decide("lane", facts, { config, subject: <slug> })`; forced → refuse, listing reasons and naming `change_new <name> --from-fix`;
4. `testCommand` set; run through `runVerify` at the project root with `verifyEnv` (guard, redaction, `verify.timeout`), tail 4 KiB; exit 0 required, otherwise refuse with the tail;
5. open pull requests with head `fix/<slug>`: any not authored by `whoami().login`, or more than one → refuse naming them; one own → it is updated; none → created (the same ownership rule as `pullRequestChoice`, without the `Refs` check);
6. `guardedPush(exec, root, "origin", "HEAD:refs/heads/fix/<slug>")`;
7. create the pull request (`title` = first commit subject since `M`, `body` from `fixPullRequestBody`) or `updatePullRequest` with its version.
Commit subjects come from `git log --no-merges`, so integration merges never become the title. The body has the commit list, `## Test` (command, exit code, HEAD short SHA, output tail in a fence), and the `lane` decision block (`DecisionRecord` with `point: lane`, `subject: <slug>`, `source: rule`, outcome, reason, facts), with `behavior_change` and `capabilities` inside the outcome when set; `reason` is the reasons joined with `; `, or `within the small-fix limits`. `neutralizeClosing` runs on the text outside the block. The test output is untrusted (repository code prints it): its fence is longer than its longest backtick run, and any of its lines starting `<!-- livespec:decision:` is indented so `parseDecisionBlocks` cannot read a forged record. *Alternative:* skip the test when HEAD equals the pushed head. Rejected: a rerun after a config change must re-prove the test.

**D4. `guardedPush` caller list.** `src/tools/fix-ship.ts` joins `change-ship.ts` and `change-push.ts`; `tests/guard/push-callers.test.ts` allows the three. The refspec branch comes from `git.branch()` after the fix-branch check, never from a parameter (the tool has no parameters).

**D5. `change_new --from-fix` reuses `change_new`.** The tool gains an optional boolean `from_fix`. With it: refuse unless on a fix branch with a clean tree and no open pull request from that branch; the name rules of `change_new` still apply, and `livespec/<name>` must not exist. Then, in order: fetch and compute `M`; create the issue with `CHANGE_BODY_TEMPLATE`, `Branch: livespec/<name>`, `Base: M`, the Proposal seeded with `Moved from fix/<slug>:` and the commit subjects, labels `livespec` and `livespec:phase/define`; `git branch -m fix/<slug> livespec/<name>`; set `branch.livespec/<name>.livespecBase = M`. A failure after the issue is created reports the issue number and leaves the branch as it is; a rerun of `change_start #N` reconciles because the issue records `Branch`/`Base` and the config key exists once the rename and config write succeed. *Alternative:* rename first. Rejected: an issue is easy to close, a lost branch name is not.

**D6. Fix card.** `buildCardInput` checks the branch before `resolveChange` and reuses the facts while HEAD and the integration branch are unchanged (a session memo keyed by HEAD, like `fetchOnce` in `src/ship/context.ts`), so a refresh on every turn does not fetch every time: on a fix branch it returns `{ kind: "fix", slug, outcome }` from the lane facts (errors become a line, never a throw), and `phase-card.ts` renders `Next: fix_ship` or `Next: change_new <name> --from-fix` with the reasons. No subagent next step exists on this path, which satisfies `subagent-policy` "Small-fix lane". `spec_status`, `spec_next` and `/livespec next` share the same fix builder (`fixCardInput`, reached through `readCurrentChange` in `src/tools/read-change.ts`), so the tools and the card always agree. The card never records a decision; only `fix_ship` writes the block.

**D7. Bare work in the guard.** In `checkPath`, after the `.pi/livespec/` block, the guard resolves the path; when it is inside the project, not under `specs/`, tracked (`git ls-files --error-unmatch`), and the branch is neither `livespec/*` nor `fix/*`, it appends `<YYYY-MM-DD> — <path> — <tool> outside a change or fix branch` (local date) to `specs/bare-work.md` (creating it) unless an entry for that date already lists the path, and stores a warning under the call's `toolCallId`. A `tool_result` handler appends the warning text to that call's result content; `tool_execution_end` drops any entry left by a call that was blocked later or aborted (that call's line stays logged, an accepted over-report). `checkPath` becomes async and receives the session, the child flag, the tool name and the `toolCallId`; the bare-work branch has its own `try`, so its errors become a not-logged warning and never reach the fail-closed catch. The append uses `appendFile` after a `parseBareWork` read, serialized by a module-level promise chain. A failure to read the branch, run `isTracked` or write the log does not block the call (bare work is advisory, unlike the fail-closed blocking rules): the warning says the work was not logged and why. Child sessions get neither a log line nor a warning. *Alternative:* block until logged. Rejected by the user's decision (warn, never block).

**D8. Config.** `testCommand` is a project config string; any other type is a warning and ignored. It is read only by `fix_ship`.

## Risks / Trade-offs

- [A rename in a spec counts as remove + add and forces a full change] → accepted; the reason names both, and a rename is a contract change.
- [`git show HEAD:` ignores uncommitted spec edits] → `fix_ship` refuses a dirty tree, and the card states it shows committed work.
- [Bare work via `bash` is not seen] → documented as a non-goal in `docs/architecture.md`.
- [The guard now writes a file] → the write is outside `.pi/livespec/`, never blocks, and is skipped in uninitialized projects and child sessions.
- [The seeded `## Proposal` of a moved fix satisfies the `issue#Proposal` output, so the card may not ask for a real one] → accepted: the define gate is `human`, and the seed names the fix commits so the reviewer sees it is a seed; the agent still writes the Proposal through `spec_write`.
- [`change_new --from-fix` fails between issue and rename] → the message names the issue and the exact `git branch -m` to finish; the issue is in `define` and harmless.
