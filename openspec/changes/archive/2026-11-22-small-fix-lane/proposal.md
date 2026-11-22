## Why

Every livespec change today needs an issue, units, gates and a review, so a typo or a one-line bug fix is either over-processed or done outside the flow, where nothing records it. LS-09b (#33, part 2 of LS-09 #9) adds a small-fix lane with no ceremony that still keeps the contract honest: a fix that turns out to change behavior is forced into a full change and keeps its commits, and edits made outside any lane are logged as debt.

## What Changes

- **`fix_start <slug>`**: creates and switches to `fix/<slug>` at the fetched integration branch head. No issue, no subagents, no push.
- **Rule `lane`** (`registerRule`), default pack config `decisions.lane: { mode: rule, max_files: 3, max_lines: 100 }`, run on `git diff <merge-base>..HEAD`. It forces a full change when the diff has more than `max_files` files or `max_lines` changed lines, adds or removes a requirement or scenario, creates a capability, or touches `specs/constraints.md` or `specs/decisions/`.
- **`fix_ship`**: on a fix branch with a clean tree and at least one commit after the merge base, refuses when the lane is forced, when another login's pull request has the same head, or when config `testCommand` is unset or exits non-zero; otherwise pushes through `guardedPush` and opens (or updates) one pull request whose body has the test result and the `lane` decision block, with `behavior_change: declared-none` when capability code changed with no spec change. A human merges it.
- **`change_new <name> --from-fix`**: on a fix branch with no open pull request, creates the change issue in `define`, renames the branch to `livespec/<name>` keeping its commits, and records `Branch` and `Base`.
- **Fix card**: on a `fix/<slug>` branch the phase card shows the lane outcome and names `fix_ship` or `change_new --from-fix`; it never suggests a subagent.
- **Bare work**: a `write` or `edit` of a tracked file outside `specs/` while neither a `livespec/*` nor a `fix/*` branch is checked out runs, gets a guard warning, and the guard appends a line to `specs/bare-work.md` (once per file per day).
- **Config `testCommand`** in the project config.

**Guarded push**
- From: only `change_ship` and `change_push` call `guardedPush`, with the issue's `Branch` line as refspec.
- To: `fix_ship` is a third caller, after its refusal checks, with refspec `HEAD:refs/heads/fix/<slug>` taken from the checked-out branch.
- Reason: a small fix ships as a pull request too.
- Impact: non-breaking; the guard still blocks every `git push` the agent runs.

**Change new**
- From: `change_new` creates only an issue in `shape` and never a branch.
- To: with `--from-fix` it creates the issue in `define` and renames the current fix branch.
- Reason: a forced fix must keep its commits.
- Impact: non-breaking; `change_new <name>` without the flag is unchanged.

## Capabilities

### New Capabilities
- `small-fix-lane`: `fix_start`, the `lane` rule and its facts, `fix_ship` and its pull request body with the decision block, `change_new --from-fix`'s fix-side behavior, and the fix card.

### Modified Capabilities
- `command-guards`: "Guarded push" gains `fix_ship` as a caller; a new "Bare work" requirement for the warning and the debt line.
- `change-tools`: "Change new tool" gains `from_fix` (`--from-fix`).
- `change-tools`: "Status and next tools" return the fix step on a fix branch.
- `context-injection`: "Resume at session start" shows the fix card on a fix branch.
- `decision-seam`: "Decision records" records a `lane` decision only in the fix pull request body; "Rule registry and pack config" changes its unknown-point example from `lane` to `nope`.
- `init-and-doctor`: "Config files" accepts `testCommand`.
- `flow-pack`: "Default flow pack" gains `decisions.lane` with its defaults.

## Impact

- **New code:** `src/fix/` (lane facts from git, the `lane` rule, fix pull request body, branch rename), tools `src/tools/fix-start.ts`, `fix-ship.ts`; bare-work append in `src/guard/`.
- **Changed code:** `src/tools/change-new.ts`, `src/hooks/guard.ts` (plus a `tool_result` warning), `src/hooks/card-input.ts` and `phase-card.ts` (fix card), `src/tools/read-change.ts`, `spec-status.ts`, `spec-next.ts` and `src/commands/next.ts` (fix step), `src/engine/git.ts` (numstat, rename, show at a revision), `src/decide/registry.ts` and `tests/decide/registry.test.ts` (unknown-point example), `src/config.ts`, `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json`.
- **Docs:** `docs/architecture.md` (small-fix lane, bare work).
