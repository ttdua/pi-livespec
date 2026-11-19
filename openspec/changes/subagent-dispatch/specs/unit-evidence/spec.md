## MODIFIED Requirements

### Requirement: Unit start tool
`unit_start` SHALL take only a unit id. When a lane is open for the unit (see `parallel-lanes`), every check on the working tree, HEAD and `Verify` SHALL use the lane worktree; otherwise they use the change worktree. It MUST refuse, writing nothing, in each of these cases, checked in this order:
- the change is not in a `per: unit` phase;
- no unit lock exists;
- the unit is unknown or done;
- the unit is frozen or stale;
- a unit in its `Depends` is not done;
- the unit is blocked;
- the unit is already started with its current digest;
- the working tree is dirty;
- another unit is started in the same worktree;
- the guard blocks its `Verify` command.

Otherwise it SHALL record HEAD as the pre SHA. For a unit that is not verifier pending, it SHALL then run `Verify` at HEAD and require a valid red, or a green for a `Kind: refactor` unit. When the run has the wrong class, the tool MUST refuse, write nothing, and name the class, the exit code and the options: a regression pin or a drop through `unit_amend`, or a fixed `Verify`. On success it SHALL post one own `unit-start` comment with the unit, its digest, the `Verify` command, the pre SHA, the pre exit code, the verdict and the redacted output tail.

#### Scenario: Red at pre starts the unit
- **WHEN** U1 is locked, pending, with no unmet `Depends`, the tree is clean and `Verify` exits 1 at HEAD
- **THEN** a `unit-start` comment for U1 records the HEAD SHA and exit 1, and U1 is started

#### Scenario: Green at pre is refused
- **WHEN** U1 is not a refactor unit and its `Verify` exits 0 at HEAD
- **THEN** `unit_start U1` refuses, names exit 0 and the regression-pin, drop and fix options, and posts nothing

#### Scenario: Refactor unit must pass at pre
- **WHEN** U2 has `Kind: refactor` and its `Verify` exits 1 at HEAD
- **THEN** `unit_start U2` refuses and posts nothing; and when its `Verify` exits 0, U2 is started with verdict `green`

#### Scenario: Dirty tree
- **WHEN** the tree has an uncommitted change and `unit_start U1` runs
- **THEN** the tool refuses, says to commit first, and does not run `Verify`

#### Scenario: Frozen unit
- **WHEN** U1 is frozen after a web edit
- **THEN** `unit_start U1` refuses and points to `unit_amend`

#### Scenario: Unmet dependency
- **WHEN** U3 has `Depends: U1` and U1 is pending
- **THEN** `unit_start U3` refuses and names U1

#### Scenario: One started unit at a time
- **WHEN** U1 is started in the change worktree, no lane is open for U2, and `unit_start U2` runs
- **THEN** the tool refuses and names U1

#### Scenario: Started in a lane
- **WHEN** U1 is started in the change worktree, a lane is open for U2, and `unit_start U2` runs with U2's lane clean and `Verify` red there
- **THEN** U2 is started with the lane's HEAD as its pre SHA

#### Scenario: Restart after an amendment
- **WHEN** U1 is started and an approved amendment changes U1's `Verify`
- **THEN** `unit_start U1` runs again with the new `Verify` and posts a new `unit-start` comment

### Requirement: Unit finish tool
`unit_finish` SHALL take only a unit id and SHALL be the only tool that ticks a unit.

A unit is **started** when its latest own `unit-start` comment is newer than its latest own `receipt` and its status line is pending. A unit is **receipted, not ticked** when its latest receipt is newer than its latest `unit-start`, matches its current digest, and its status line is pending. Before any other check, `unit_finish` MUST refuse, writing nothing, when the unit has an unresolved blocking finding (see `review-findings`), or when the pack's non-advisory unit-reviewer entry holds for the unit (evaluated without `context>=N%` conditions) and no completed unit review (see `review-findings`) records the reviewed commit. The reviewed commit SHALL be HEAD; for a unit that ran in a lane and was merged, it SHALL be the lane head that the merge commit at HEAD brought in as its second parent. Findings of an advisory entry MUST NOT refuse a tick. For a receipted, not-ticked unit, `unit_finish` SHALL only tick the unit, without running `Verify` and without posting another receipt, provided the tree is clean and the unit is neither frozen nor stale. Otherwise it MUST refuse, writing nothing, when:
- the unit is not started;
- the unit is frozen or stale, or its digest differs from the digest in its `unit-start` comment;
- the unit is blocked;
- the working tree is dirty;
- the guard blocks its `Verify` command.

Otherwise it SHALL run `Verify` at HEAD.

When the run is `green`, the tool SHALL first post a `receipt` comment, then tick the unit's status line with the byte-preserving tick in one version-checked body write. A unit whose latest receipt is newer than its latest `unit-start` and matches its digest, while its status line is pending, SHALL be ticked by `unit_finish` without running `Verify` again.

When the run is `red` or `invalid`, the tool SHALL post a `progress` decision record as a failed attempt and report the attempt count, the failure signature, and either a retry with the `debugging-and-error-recovery` skill or the block.

#### Scenario: Green at post
- **WHEN** U1 is started with pre exit 1, the work is committed, and `Verify` exits 0 at HEAD
- **THEN** a `receipt` comment records the pre and post SHAs and exits, and U1's status line is the only line of the body that changed

#### Scenario: Not green at post
- **WHEN** U1 is started and `Verify` exits 1 at HEAD
- **THEN** no receipt is posted, U1 stays pending and started, a `progress.U1` record is posted, and `unit_attempts.U1` is 1

#### Scenario: Not started
- **WHEN** U1 is pending and has no `unit-start` comment
- **THEN** `unit_finish U1` refuses and says to run `unit_start U1`

#### Scenario: Crash between receipt and tick
- **WHEN** U1's receipt was posted and the tick write failed
- **THEN** U1 is not started, the next step says to run `unit_finish U1` again, and that run ticks U1 exactly once without running `Verify` or posting another receipt

#### Scenario: Digest changed since start
- **WHEN** U1 is started and its body was edited, so its digest differs from the `unit-start` digest
- **THEN** `unit_finish U1` refuses and points to `unit_amend`

#### Scenario: Unresolved blocking finding
- **WHEN** U1 is started, committed and green, and its latest `finding-summary` holds a `WARNING` finding that is neither resolved by a later passing review nor rebutted
- **THEN** `unit_finish U1` refuses, writes nothing, and names the finding and the fix-or-rebut options

#### Scenario: Review required but not run
- **WHEN** U1 has `Difficulty: medium`, the unit-reviewer entry has `when: ["difficulty>=medium"]`, U1 is green at HEAD `abc`, and no unit `finding-summary` records `abc`
- **THEN** `unit_finish U1` refuses and names the unit review as the next step

#### Scenario: Lane review accepted after merge
- **WHEN** U2 was reviewed in its lane at `l1` with no blocking finding, and HEAD of the change branch is the merge commit whose second parent is `l1`
- **THEN** `unit_finish U2` does not refuse for a missing review

#### Scenario: Incomplete review does not count
- **WHEN** the only unit review of U1 at HEAD has status `NEEDS_CONTEXT`
- **THEN** `unit_finish U1` refuses and names the unit review as the next step

#### Scenario: Receipted unit with a new blocking finding
- **WHEN** U1 is receipted, not ticked, and a later `finding-summary` for U1 holds an unresolved `CRITICAL` finding
- **THEN** `unit_finish U1` refuses and does not tick

