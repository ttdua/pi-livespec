## Design Summary

**Intent.** Give small fixes a path with no ceremony, while making it impossible to hide a behavior change inside a "small fix". This change (LS-09b, issue #33, part 2 of 3 of LS-09 #9) adds the small-fix lane. It depends on LS-09a (#32, shipped as PR #35): `guardedPush`, the change diff from the merge base, the pull request tools and the `durable-docs` facts already exist.

**Why.** From #9, "ceremony in the wrong places": a typo or a one-line bug fix should not need an issue, units, gates and subagents; but the agent must not use the light path for work that changes the contract. A human still merges every fix.

**Existing requirements involved**
- `subagent-policy` "Policy decides suggestions, not the flow", scenario "Small-fix lane": no next step names `subagent_dispatch` in the small-fix lane (deferred from LS-07, satisfied here).
- `decision-seam` "Small-fix decision block": the marked `<!-- livespec:decision:<point> -->` block format, formatter and parser already exist; this change writes it into the fix pull request body.
- `spec-formats` "Bare-work log format": `specs/bare-work.md` lines `<date> — <files> — <summary>` already parse and serialize; this change appends to it.
- `command-guards` "Guarded push": today only `change_ship` and `change_push` may call `guardedPush`. **This change alters that requirement**: `fix_ship` becomes a third caller, after its own refusal checks.
- `change-tools` "Change new tool": today `change_new` creates only an issue and never a branch. **This change alters it**: with `--from-fix` it also renames the current fix branch.
- `flow-engine` / phase card: today any branch that is not `livespec/<name>` shows the open-changes list; a `fix/<slug>` branch gets its own card.

**Goals**
- `fix_start <slug>`: creates `fix/<slug>` from the fetched integration branch. No issue, no subagents.
- Rule `lane` (registered with `registerRule`), pack config `decisions.lane: { max_files: 3, max_lines: 100 }`, on `git diff <merge-base>..HEAD`. It forces a full change when: more than `max_files` files or `max_lines` changed lines; the spec diff adds or removes a requirement or a scenario; a new capability is created; `specs/constraints.md` or `specs/decisions/` is touched.
- `fix_ship`: refuses when the lane is forced (and names `change_new --from-fix`), when the tree is dirty, or when config `testCommand` is unset or exits non-zero; otherwise pushes through `guardedPush` and opens one pull request whose body holds the test result and the `lane` decision block, with `behavior_change: declared-none` when code under a capability's `paths` changed with no spec change.
- `change_new <name> --from-fix`: on a fix branch, creates the change issue, renames the branch to `livespec/<name>` keeping its commits, records `Branch` and `Base`, and the change continues at `define`.
- Bare work: a `write` or `edit` of a tracked file outside `specs/`, while neither a `livespec/*` nor a `fix/*` branch is checked out, is allowed with a guard warning, and the guard appends a debt line to `specs/bare-work.md`.
- Phase card on `fix/<slug>`: shows the lane outcome so far and the next step (`fix_ship`, or `change_new --from-fix` when forced).
- Config `testCommand`; docs `docs/architecture.md` (small-fix lane).

**Non-goals**
- Initiatives, `change_split`, `size-limits`, park/resume (LS-09c).
- The `behavior-change` record and the drift audit that re-checks `declared-none` (LS-10).
- Pull request feedback polling or `change_close` for fix pull requests: a human merges, and nothing on the plugin side follows the merge.
- Detecting bare work done through `bash` (for example `sed -i`): the guard sees only `write` and `edit` paths. No `git status` scan is added.

**Anti-goals** (a failure even if it technically works)
- A fix pull request opened without the lane check and a passing `testCommand`, by any path the agent controls (parameter, flag, environment).
- A fix that adds or removes a requirement or scenario reaching a pull request as a small fix.
- Losing the fix commits when it is forced into a full change.
- Bare work blocked outright: it is warned and logged, not refused.

## Alternatives Considered

### Alternative A: Guard logs bare work itself (chosen)
- **Approach**: the guard's `write`/`edit` path check, outside a change or fix branch, appends `<date> — <file> — <tool> edit outside a change or fix branch` to `specs/bare-work.md` (once per file per day) and returns a warning; the call still runs.
- **Pros**: does not depend on the agent; one place; no new tool.
- **Cons**: the summary is generic; `bash` edits are not seen.
- **Why chosen**: the user agreed; the log exists to show debt, and a reliable generic line beats a meaningful line the agent can skip.

### Alternative B: Guard warns, agent logs through `bare_work_log`
- **Approach**: the guard only warns; a new tool records the summary.
- **Pros**: meaningful summaries.
- **Cons**: the agent can ignore the warning, so debt goes unrecorded.
- **Why not chosen**: weaker guarantee for the same scope.

### Alternative C: Block bare work
- **Approach**: the guard refuses tracked edits outside a change or fix branch.
- **Pros**: no debt at all.
- **Cons**: contradicts #9 (warning plus debt line) and blocks legitimate quick local work.
- **Why not chosen**: not what the issue specifies.

## Agreed Approach

Alternative A for bare work, with the rest of the lane as #9 and #33 describe it: a fix branch has no issue; `fix_ship` is the only way out, guarded by the `lane` rule and `testCommand`; a forced fix becomes a full change with `change_new --from-fix`, which keeps the commits by renaming the branch.

## Key Decisions

- **Bare work logged by the guard** (user decision): append once per file per day, warn, never block; `bash` edits out of scope.
- **Defaults** (agreed in #33): `max_files: 3`, `max_lines: 100`; small fixes open a pull request instead of committing directly.
- **Requirement and scenario detection** (my call): compare the parsed living specs at the merge base with HEAD by requirement name, and by scenario name within a requirement. A rename counts as one removal plus one addition and therefore forces; text edits inside a requirement or scenario do not force.
- **Changed lines** (my call): added plus deleted lines of `git diff --numstat <merge-base>..HEAD`; binary files count as files only.
- **`fix_ship` reruns** (my call): when a pull request from `fix/<slug>` is already open, `fix_ship` re-runs every check, pushes and updates that pull request's body; it never opens a second one.
- **`--from-fix` while a fix pull request is open** (my call): refused, naming the pull request; a human closes it first, so one branch never backs two pull requests.
- **`--from-fix` start phase** (my call): the issue gets label `define` with `Branch` and `Base` (the merge base) set; its `## Proposal` is seeded with the fix branch's commit subjects so the define phase has a starting point.
- **No `testCommand`** (my call): `fix_ship` refuses and says to set it in `.pi/livespec/config.yaml`; the test output in the body is the exit code plus a capped tail.
- **Fix card** (my call): the phase card on `fix/<slug>` runs the lane rule on the current diff and never suggests a subagent.

## Open Questions

- None blocking. Technical choices (where the fix tools live, how the lane facts are built from git, how the guard writes the log without racing itself) are left to design.
