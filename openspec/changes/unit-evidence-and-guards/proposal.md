## Why

After LS-05, a unit can still be marked done without proof, and the agent can step around the workflow with shell commands such as `gh issue edit`, `git push` or an edit of `.pi/livespec/flow.yaml`. LS-06 (issue #6) closes both gaps. The parent session runs every `Verify` and posts the receipts ([ADR 0003](../../../docs/decisions/0003-parent-owned-evidence.md)). A `tool_call` guard inside pi blocks direct forge writes and pushes ([ADR 0004](../../../docs/decisions/0004-guards-inside-pi.md)). After it, a change can be built inline with receipts, gates and guards.

## What Changes

- **Unit loop.**
  - `unit_start` refuses unless the tree is clean, the unit is locked and not frozen, its `Depends` are done and it is not blocked. It then records the pre SHA in a `unit-start` comment and requires `Verify` to fail. A `Kind: refactor` unit must pass instead.
  - **Verifier pending.** When the unit's test file does not exist yet, the first commit must contain only the unit's test files and must fail `Verify`. That commit becomes the pre.
  - `unit_finish` runs `Verify` at HEAD and requires exit 0. It then posts the `receipt` and ticks the unit. It is the only path that ticks a unit.
- **Attempts and the `progress` rule.**
  - Each failed `unit_finish` posts a `progress` decision record. The `unit_attempts.U<n>` counter is derived from these records, the same way `change_iterations` is derived from `stale` comments.
  - Reaching `unit_attempts`, or two identical failure signatures in a row, makes the unit `BLOCKED` until a stuck report is answered with a choice.
- **Plan check `verify-red-on-base`.** It runs every unit's `Verify` on `Base` in a temporary worktree, only when the plan gate is requested. To support it, the check registry gains gate-only checks.
- **Guards** (`tool_call`, fail closed). They block:
  - forge writes through `gh`, `tea`, `curl` and `wget`;
  - every push and pull request command, including wrapper forms and git aliases;
  - obscured commands that contain a dangerous token;
  - agent writes under `.pi/livespec/`.

  `guardedPush` is the only push path, reserved for livespec tools (LS-09).
- **Settle.** `agent_before_settle` asks for one continuation when a unit is started, the tree is dirty or a registered condition holds. If the work is still unfinished after it, the hook posts an `incomplete` comment, and the card shows its items.
- **Work in progress.** Agent-skills upgrades are blocked only while a unit is started and not finished.
- **Config.** `verify.setup` and `verify.timeout` are added to the project config.
- **Docs.** `docs/architecture.md` describes evidence and guards, and its "Known gaps" list drops the two gaps LS-06 closes.

Deviations from the issue text:
- **`BLOCKED` is derived**, not a third status line. The LS-02 body format is unchanged.
- **The guard also covers `.pi/livespec/`**, as the LS-05 known gaps promised.
- **`verify-red-on-base` runs only at the plan gate and is waivable.** It never runs on a refresh. A refactor unit's `Verify` must pass on `Base`.
- **A failed `unit_finish` posts no receipt.** Its evidence is the `progress` decision record.
- **`unit_attempts` is derived, not a `counter` comment.** The issue says `unit_finish` raises a counter comment. Deriving the count instead means a retried tool cannot count twice, and a chosen stuck answer restarts the budget without another write. LS-05 made the same choice for `change_iterations`.

## Capabilities

### New Capabilities
- `unit-evidence`: `unit_start` and `unit_finish`, `unit-start` and `receipt` comments, verifier pending, `Verify` execution and valid red, attempts, `BLOCKED` units and their lift, the `verify-red-on-base` check, and the work-in-progress predicate.
- `command-guards`: the `tool_call` guard over `bash`, `write` and `edit`, covering forge writes, pushes and pull requests, obscured commands and `.pi/livespec/` writes, with reasons that name the tool to use, plus `guardedPush`.
- `settle-continuation`: the `agent_before_settle` hook, its conditions and registration seam, the single continuation, and the `incomplete` comment.

### Modified Capabilities
- `flow-engine`:
  - **Change state from issue and git** derives started, receipted and blocked units.
  - **Next step** reports started and blocked units.
  - **Next step precedence** puts blocked and started units before the next ready unit.
  - **Loop counters** derives `unit_attempts.<unit>` from `progress` records.
  - **Named checks over LS-02 validators** gains gate-only checks.
- `flow-pack`: **Default flow pack** adds `verify-red-on-base` to `plan` and `decisions.progress`, so the canonical fixture changes.
- `phase-gates`: **Gate tool** runs gate-only checks when the gate is requested.
- `decision-seam`: adds the **Progress rule**.
- `agent-skills-content`: **No upgrade during work in progress** uses the started-unit signal.
- `init-and-doctor`: **Config files** accepts `verify.setup` and `verify.timeout`.
- `context-injection`: **Phase card content** shows started and blocked units, and the items of the `incomplete` comment.

## Impact

- New modules `src/evidence/`, `src/guard/` and `src/hooks/{guard,settle}.ts`, and new tools `src/tools/unit-start.ts` and `src/tools/unit-finish.ts`.
- Changes to `src/engine/` (registry, checks, snapshot, state types, next step), `src/tools/spec-gate.ts`, `src/hooks/phase-card.ts`, `src/content/wip.ts` registration, `src/decide/registry.ts`, `src/config.ts`, `src/extension.ts`, `src/packs/agent-skills.yaml` and `tests/fixtures/agent-skills.pack.json`.
- `Git` gains temporary worktree operations, `revList` and `pathExistsAt`. `git push` is not on `Git`: it exists only inside `src/guard/push.ts`.
- `ChangeState.issue` gains the issue `url`, used to link receipts and failed attempts.
- New marker kind `unit-start`. No new runtime dependency.
- Agents inside pi can no longer run `gh` write commands, `git push` or `tea` writes. Humans running commands outside pi are not affected.
