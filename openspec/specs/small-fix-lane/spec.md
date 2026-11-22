# small-fix-lane Specification

## Purpose

Defines the small-fix lane: fix branches with no issue, `fix_start`, the `lane` rule that forces a full change, `fix_ship` opening one tested pull request with its decision block, moving a fix into a change with `change_new --from-fix`, and the fix card.

## Requirements

### Requirement: Fix branch
A fix branch SHALL be a local branch named `fix/<slug>` where `<slug>` is a kebab-case name. The system MUST identify a fix only by its checked-out branch name; it SHALL store no issue, git config key or marked comment for a fix. The merge base of HEAD and `origin/<integration branch>`, fetched first, SHALL be the start of the fix diff. A fix has no fallback base: when the fetch or the merge base fails, every fix tool MUST refuse and say so.

#### Scenario: Hand-made fix branch
- **WHEN** a human creates `fix/typo` with `git switch -c` and checks it out
- **THEN** the phase card and `fix_ship` treat it as a fix branch

#### Scenario: Not a fix branch
- **WHEN** the checked-out branch is `fix/Typo_1` or `fixes/typo`
- **THEN** it is not a fix branch

### Requirement: Fix start tool
`fix_start <slug>` SHALL fetch the integration branch from `origin`, create the local branch `fix/<slug>` at the fetched head, and switch to it. It MUST NOT create an issue, push, or suggest a subagent. It MUST refuse, changing nothing, when the slug is not kebab-case, the working tree is dirty, `fix/<slug>` already exists, the integration branch is unknown, the current branch is a `livespec/*` change branch, or it runs in a child session.

#### Scenario: Start a fix
- **WHEN** `fix_start typo-in-readme` runs on `main` with a clean tree
- **THEN** the checked-out branch is `fix/typo-in-readme` at `origin/main`, no issue exists for it, and nothing was pushed

#### Scenario: Dirty tree
- **WHEN** `fix_start typo` runs with an uncommitted change
- **THEN** it refuses and no branch is created

#### Scenario: From a change branch
- **WHEN** `fix_start typo` runs while `livespec/rate-limit` is checked out
- **THEN** it refuses and names the change branch

### Requirement: Lane rule
The system SHALL register the rule `lane` with `registerRule`. Its config SHALL be `decisions.lane: { mode: rule, max_files, max_lines }`, where `max_files` and `max_lines` are positive integers. The rule SHALL run on facts built by code from `git diff <merge-base>..HEAD` of the fix branch, and its outcome SHALL be the map `{ lane, reasons, behavior_change?, capabilities? }`, where `lane` is `forced` when any of these hold, with one entry in `reasons` per condition, and `small` with no reasons otherwise:
- more changed files than `max_files`, a renamed file counting once;
- more changed lines (added plus deleted; binary files count no lines) than `max_lines`;
- a living spec `specs/<capability>/spec.md` gains or loses a requirement, compared by requirement name, or a requirement present on both sides gains or loses a scenario, compared by scenario name;
- a directory `specs/<capability>/` exists at HEAD and not at the merge base;
- `specs/constraints.md` or a file under `specs/decisions/` changed.

Text edits inside an existing requirement or scenario MUST NOT force. A renamed requirement or scenario counts as one removal and one addition. The rule MUST NOT ask a human.

#### Scenario: Small fix
- **WHEN** the fix diff changes 2 files and 12 lines and edits the text of one scenario in `specs/forge-read/spec.md`
- **THEN** the outcome is `small`

#### Scenario: Added requirement forces
- **WHEN** the fix diff changes 1 code file and adds `### Requirement: Retry budget` to `specs/forge-read/spec.md`
- **THEN** the outcome is `forced` and a reason names `forge-read` and `Retry budget`

#### Scenario: Removed scenario forces
- **WHEN** the fix diff removes `#### Scenario: Stale cache` from an existing requirement
- **THEN** the outcome is `forced` and a reason names the requirement and the scenario

#### Scenario: Too many files
- **WHEN** with the default config the fix diff changes 4 files
- **THEN** the outcome is `forced` and a reason names `max_files` 3

#### Scenario: Too many lines
- **WHEN** with the default config the fix diff changes 101 lines in 1 file
- **THEN** the outcome is `forced` and a reason names `max_lines` 100

#### Scenario: New capability
- **WHEN** the fix diff creates `specs/retry-policy/spec.md`
- **THEN** the outcome is `forced` and a reason names `retry-policy`

#### Scenario: Governance files
- **WHEN** the fix diff changes `specs/constraints.md` or adds `specs/decisions/0007-x.md`
- **THEN** the outcome is `forced` and a reason names the file

#### Scenario: Project override
- **WHEN** `.pi/livespec/flow.yaml` extends the default pack with `decisions.lane: { mode: rule, max_files: 5 }`
- **THEN** the effective `lane` config has `max_files: 5` and `max_lines: 100`

#### Scenario: Invalid limit
- **WHEN** a pack sets `decisions.lane: { mode: rule, max_files: 0 }`
- **THEN** validation returns an error naming `max_files` with its line and column

### Requirement: Declared no behavior change
When the fix diff changes a non-spec file matched by a living spec's `paths` and that capability's `spec.md` is unchanged, the `lane` outcome SHALL hold `behavior_change: declared-none` and `capabilities` listing those capabilities. It MUST NOT force a full change by itself.

#### Scenario: Code without spec change
- **WHEN** the fix diff changes `src/forge/read.ts`, the `forge-read` spec has `paths: [src/forge/**]`, and `specs/forge-read/spec.md` is unchanged
- **THEN** the outcome has `lane: small`, `behavior_change: declared-none` and `capabilities: [forge-read]`

#### Scenario: Code with spec change
- **WHEN** the same code changes and `specs/forge-read/spec.md` changes the text of a scenario
- **THEN** the outcome has no `behavior_change` and no `capabilities`

### Requirement: Fix ship tool
`fix_ship` SHALL take no parameters and run under the evidence lock. It MUST refuse, pushing and opening nothing, in this order:
1. the current branch is not a fix branch, the call is in a child session, or the forge is read-only;
2. the working tree is dirty;
3. the fetch or the merge base fails, or there is no commit between the merge base and HEAD;
4. the `lane` outcome is `forced`: the message lists every reason and names `change_new <name> --from-fix`;
5. config `testCommand` is not set;
6. `testCommand`, run at the project root through the guard with the `verify.timeout` limit, does not exit 0: the message holds the exit and a redacted output tail;
7. an open pull request with head `fix/<slug>` was not opened by the current forge login, or more than one is open: the message names them.

It SHALL then push with `guardedPush` to `origin` with refspec `HEAD:refs/heads/fix/<slug>`, and open one pull request from `fix/<slug>` to the integration branch, or update the title and body of the one open pull request with that head opened by the current login. It MUST NOT open a second pull request for the same branch. A human merges the pull request on the forge.

#### Scenario: Ship a small fix
- **WHEN** `fix_ship` runs on `fix/typo` with a clean tree, outcome `small`, and `testCommand: bun test` exiting 0
- **THEN** `fix/typo` is pushed to `origin` and one pull request from `fix/typo` to the integration branch is open

#### Scenario: Forced fix refused
- **WHEN** `fix_ship` runs and the fix diff adds a requirement
- **THEN** it refuses, names the requirement and `change_new <name> --from-fix`, and nothing is pushed

#### Scenario: Failing tests
- **WHEN** `testCommand` exits 1
- **THEN** `fix_ship` refuses with the exit code and the output tail, and nothing is pushed

#### Scenario: No test command
- **WHEN** the project config has no `testCommand`
- **THEN** `fix_ship` refuses and says to set `testCommand` in `.pi/livespec/config.yaml`

#### Scenario: Nothing to ship
- **WHEN** `fix_ship` runs on `fix/typo` with no commit after the merge base, for example after its pull request was merged
- **THEN** it refuses, says there is nothing to ship, and nothing is pushed

#### Scenario: Foreign pull request
- **WHEN** pull request 13 with head `fix/typo` is open and was opened by another login
- **THEN** `fix_ship` refuses, names #13, and nothing is pushed or edited

#### Scenario: Rerun updates the pull request
- **WHEN** `fix_ship` already opened pull request 12 from `fix/typo`, a new commit is added, and `fix_ship` runs again with passing tests
- **THEN** the new HEAD is pushed, pull request 12's body shows the new test result, and no other pull request exists for `fix/typo`

### Requirement: Fix pull request body
The fix pull request body SHALL contain, in order: the subjects of the commits since the merge base; a `## Test` section with the `testCommand`, its exit code, the short HEAD SHA it ran at, and the redacted output tail, at most 4,096 bytes, in a fenced block; and the `lane` decision block in the format of decision-seam "Small-fix decision block", with `point: lane`, `subject: <slug>`, `source: rule`, the outcome map of "Lane rule", `reason` holding the reasons joined (or `within the small-fix limits`), and the facts. Closing keywords before an issue reference outside the decision block SHALL become `Refs`. The title SHALL be the subject of the first commit since the merge base.

#### Scenario: Body round trip
- **WHEN** `fix_ship` opens the pull request for `fix/typo`
- **THEN** `parseDecisionBlocks` of its body returns one record with `point: lane`, `subject: typo` and `outcome.lane` `small`, and the body has a `## Test` section with exit code 0

#### Scenario: Declared none in the block
- **WHEN** the outcome carries `behavior_change: declared-none` for `forge-read`
- **THEN** the decision block's outcome holds `behavior_change: declared-none` and `capabilities: [forge-read]`

#### Scenario: No closing keyword
- **WHEN** a commit subject is `Fixes #40`
- **THEN** the body says `Refs #40`

### Requirement: Fix card
On a fix branch the phase card SHALL show the fix slug, the lane outcome of the committed fix diff with its reasons, and exactly one next step: `fix_ship` when the outcome is `small`, `change_new <name> --from-fix` when it is `forced`, or, when no commit follows the merge base, that there is nothing to ship and to switch back to the integration branch. It MUST NOT name `subagent_dispatch` or `subagent_packet`. When the facts cannot be built, the card SHALL say why and still name no subagent.

#### Scenario: Small fix card
- **WHEN** the card is built on `fix/typo` with outcome `small`
- **THEN** it names `fix/typo`, outcome `small` and the next step `fix_ship`

#### Scenario: Forced fix card
- **WHEN** the card is built on `fix/typo` and the fix diff adds a requirement
- **THEN** its next step names `change_new <name> --from-fix` and lists the reason

#### Scenario: Empty fix card
- **WHEN** the card is built on `fix/typo` with no commit after the merge base
- **THEN** its next step says there is nothing to ship and does not name `fix_ship`

#### Scenario: No dispatch
- **WHEN** the card is built on any fix branch
- **THEN** no next step names `subagent_dispatch`

### Requirement: Move a fix into a change
`change_new` with `name` and `from_fix: true` (written `change_new <name> --from-fix`) SHALL, on a fix branch with a clean tree and no open pull request from it, create the change issue with the template of change-tools "Change new tool", labels `livespec` and `livespec:phase/define`, `Branch: livespec/<name>`, `Base: <merge base>` and a Proposal listing the fix's commit subjects; then rename the branch to `livespec/<name>` keeping every commit, and set `branch.livespec/<name>.livespecBase` to the merge base. It MUST refuse, changing nothing, when not on a fix branch, when the tree is dirty, when the fetch or the merge base fails, when a pull request from the fix branch is open (naming it), when `livespec/<name>` exists, or under the name rules of `change_new`. A failure after the issue is created SHALL name the issue and the remaining step.

#### Scenario: Forced fix keeps its commits
- **WHEN** `fix/retry` has 2 commits, one adding a requirement, and `change_new retry-budget --from-fix` runs
- **THEN** an issue `retry-budget` exists in `define` with `Branch: livespec/retry-budget` and `Base` equal to the merge base, the checked-out branch is `livespec/retry-budget` with the same HEAD, `fix/retry` no longer exists, and the phase card shows the change in `define`

#### Scenario: Open fix pull request
- **WHEN** pull request 12 from `fix/retry` is open and `change_new retry-budget --from-fix` runs
- **THEN** it refuses, names #12, and no issue is created

#### Scenario: Not on a fix branch
- **WHEN** `change_new retry-budget --from-fix` runs on `main`
- **THEN** it refuses and no issue is created
