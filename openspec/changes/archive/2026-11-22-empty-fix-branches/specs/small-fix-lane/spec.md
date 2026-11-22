## MODIFIED Requirements

### Requirement: Fix branch
A fix branch SHALL be a local branch named `fix/<slug>` where `<slug>` is a kebab-case name. The system MUST identify a fix only by its checked-out branch name; it SHALL store no issue, git config key or marked comment for a fix. The merge base of HEAD and `origin/<integration branch>`, fetched first, SHALL be the start of the fix diff. A fix has no fallback base: when the fetch or the merge base fails, every fix tool MUST refuse and say so.

A fix SHALL be empty when no commit follows the merge base, or when merging HEAD into `origin/<integration branch>` would leave that branch's tree unchanged, whatever merge method landed the content and whatever commits followed it. A merge that would conflict MUST NOT make a fix empty. When git cannot compute the merge without the work tree (git older than 2.38), a fix whose HEAD tree equals the `origin/<integration branch>` tree SHALL be empty. The fix card, `fix_ship` and `change_new --from-fix` MUST use this one definition.

#### Scenario: Hand-made fix branch
- **WHEN** a human creates `fix/typo` with `git switch -c` and checks it out
- **THEN** the phase card and `fix_ship` treat it as a fix branch

#### Scenario: Not a fix branch
- **WHEN** the checked-out branch is `fix/Typo_1` or `fixes/typo`
- **THEN** it is not a fix branch

#### Scenario: Squash-merged fix is empty
- **WHEN** `fix/typo` has one commit, the same change was squash-committed onto `origin/main`, and another commit followed it on `origin/main`
- **THEN** `fix/typo` is empty

#### Scenario: Rebase-merged fix is empty
- **WHEN** `fix/retry` has two commits and both were rebased onto `origin/main` as new commits
- **THEN** `fix/retry` is empty

#### Scenario: Conflicting fix is not empty
- **WHEN** `fix/typo` changes a line of `README.md` that `origin/main` changed differently after the merge base
- **THEN** `fix/typo` is not empty

### Requirement: Fix ship tool
`fix_ship` SHALL take no parameters and run under the evidence lock. It MUST refuse, pushing and opening nothing, in this order:
1. the current branch is not a fix branch, the call is in a child session, or the forge is read-only;
2. the working tree is dirty;
3. the fetch or the merge base fails: the message says so; or the fix is empty (see "Fix branch"): the message says there is nothing to ship;
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
- **WHEN** `fix_ship` runs on `fix/typo` with no commit after the merge base
- **THEN** it refuses, says there is nothing to ship, and nothing is pushed

#### Scenario: Squash-merged fix not shipped
- **WHEN** `fix_ship` runs on `fix/typo` after its change was squash-committed onto `origin/main`
- **THEN** it refuses, says there is nothing to ship, nothing is pushed, and no pull request is opened

#### Scenario: Foreign pull request
- **WHEN** pull request 13 with head `fix/typo` is open and was opened by another login
- **THEN** `fix_ship` refuses, names #13, and nothing is pushed or edited

#### Scenario: Rerun updates the pull request
- **WHEN** `fix_ship` already opened pull request 12 from `fix/typo`, a new commit is added, and `fix_ship` runs again with passing tests
- **THEN** the new HEAD is pushed, pull request 12's body shows the new test result, and no other pull request exists for `fix/typo`

### Requirement: Fix card
On a fix branch the phase card SHALL show the fix slug, the lane outcome of the committed fix diff with its reasons, and exactly one next step: `fix_ship` when the outcome is `small`, `change_new <name> --from-fix` when it is `forced`, or, when the fix is empty (see "Fix branch"), that there is nothing to ship and to switch back to the integration branch. It MUST NOT name `subagent_dispatch` or `subagent_packet`. When the facts cannot be built, the card SHALL say why and still name no subagent.

#### Scenario: Small fix card
- **WHEN** the card is built on `fix/typo` with outcome `small`
- **THEN** it names `fix/typo`, outcome `small` and the next step `fix_ship`

#### Scenario: Forced fix card
- **WHEN** the card is built on `fix/typo` and the fix diff adds a requirement
- **THEN** its next step names `change_new <name> --from-fix` and lists the reason

#### Scenario: Empty fix card
- **WHEN** the card is built on `fix/typo` with no commit after the merge base
- **THEN** its next step says there is nothing to ship and names neither `fix_ship` nor `change_new`

#### Scenario: Squash-merged fix card
- **WHEN** the card is built on `fix/typo` after its change was squash-committed onto `origin/main`
- **THEN** its next step says there is nothing to ship and names neither `fix_ship` nor `change_new`

#### Scenario: No dispatch
- **WHEN** the card is built on any fix branch
- **THEN** no next step names `subagent_dispatch`

### Requirement: Move a fix into a change
`change_new` with `name` and `from_fix: true` (written `change_new <name> --from-fix`) SHALL, on a fix branch with a clean tree and no open pull request from it, create the change issue with the template of change-tools "Change new tool", labels `livespec` and `livespec:phase/define`, `Branch: livespec/<name>`, `Base: <merge base>` and a Proposal listing the fix's commit subjects; then rename the branch to `livespec/<name>` keeping every commit, and set `branch.livespec/<name>.livespecBase` to the merge base. It MUST refuse, changing nothing, when not on a fix branch, when the tree is dirty, when the fetch or the merge base fails, when the fix is empty (see "Fix branch"; the message says there is nothing to move), when a pull request from the fix branch is open (naming it), when `livespec/<name>` exists, or under the name rules of `change_new`. A failure after the issue is created SHALL name the issue and the remaining step.

#### Scenario: Forced fix keeps its commits
- **WHEN** `fix/retry` has 2 commits, one adding a requirement, and `change_new retry-budget --from-fix` runs
- **THEN** an issue `retry-budget` exists in `define` with `Branch: livespec/retry-budget` and `Base` equal to the merge base, the checked-out branch is `livespec/retry-budget` with the same HEAD, `fix/retry` no longer exists, and the phase card shows the change in `define`

#### Scenario: Open fix pull request
- **WHEN** pull request 12 from `fix/retry` is open and `change_new retry-budget --from-fix` runs
- **THEN** it refuses, names #12, and no issue is created

#### Scenario: Not on a fix branch
- **WHEN** `change_new retry-budget --from-fix` runs on `main`
- **THEN** it refuses and no issue is created

#### Scenario: Nothing to move
- **WHEN** `change_new retry-budget --from-fix` runs on `fix/retry` with no commit after the merge base, or after its change was squash-committed onto `origin/main`
- **THEN** it refuses, says there is nothing to move, no issue is created, and the checked-out branch is still `fix/retry`
