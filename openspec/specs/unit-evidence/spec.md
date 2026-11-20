# unit-evidence Specification

## Purpose

Defines the build evidence the parent session owns: the `unit_start` and `unit_finish` tools, which run each unit's `Verify` command and record red-before and green-after receipts on the change issue; verifier-pending units; attempts and `BLOCKED` units; the `verify-red-on-base` plan check; and the work-in-progress signal derived from started units.

## Requirements

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

### Requirement: Valid red
A `Verify` run SHALL be classified from its exit status:
- exit 0 is `green`;
- exit 126 or 127, a failure to spawn, and a timeout are `invalid`;
- any other non-zero exit is `red`.

An `invalid` run MUST NOT count as a red at pre or on `Base`, and SHALL count as a failed attempt at post. `Verify` SHALL run through `/bin/sh -c` with the worktree as its working directory, with `verify.timeout` seconds (default 600) as the limit. On timeout the process group is killed.

Before every run (at pre, at the pending test-only commit, on `Base` and at post), the `Verify` command MUST be classified by the command guard. A blocked command MUST NOT be spawned: the tools refuse and point to `unit_amend`, and `verify-red-on-base` reports an error for the unit. Known tokens MUST be redacted from captured output before it is written anywhere: a `unit-start` comment, a receipt, a `progress` record, or a tool result.

#### Scenario: Command not found is not red
- **WHEN** `Verify` is `nosuchtool test` and exits 127 at pre
- **THEN** `unit_start` refuses, saying the command could not run, and posts nothing

#### Scenario: Blocked Verify is never run
- **WHEN** U1's `Verify` is `npm test && git push`
- **THEN** `unit_start U1` refuses and points to `unit_amend`, `verify-red-on-base` reports an error for U1, and the command is never spawned

#### Scenario: Token redacted everywhere
- **WHEN** `Verify` prints the forge token at pre and again in a failed post run
- **THEN** neither the `unit-start` comment, the `progress.U1` record nor the tool results contain the token

#### Scenario: Timeout
- **WHEN** `verify.timeout` is 1 and `Verify` sleeps for 5 seconds
- **THEN** the run is `invalid` with reason timeout, and the process is no longer running

### Requirement: Verifier pending
A unit SHALL be verifier pending when at least one entry of its `Files` is a test file that does not exist at the pre commit. Test files are matched by the patterns `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, `**/test_*.*`, `**/tests/**` and `**/test/**`. The pending state MUST be decided by code; no tool parameter SHALL set it. A refactor unit MUST NOT be verifier pending: `unit_start` SHALL refuse it, saying that a refactor needs an existing test.

`unit_start` on a pending unit SHALL post a `unit-start` comment with `pending: true` and the HEAD SHA, without running `Verify`. Before its post run, `unit_finish` on a pending unit SHALL require that:
- a first commit after the recorded SHA exists;
- that commit changes only test files listed in the unit's `Files`;
- `Verify` is red at that commit, run in a temporary worktree.

It MUST refuse otherwise, naming the reason, and such a refusal MUST NOT count as an attempt. The receipt SHALL record that commit as the pre.

#### Scenario: Pending start
- **WHEN** U1 lists `test/limit.test.ts` in `Files`, the file does not exist at HEAD, and `unit_start U1` runs
- **THEN** a `unit-start` comment with `pending: true` is posted and `Verify` is not run

#### Scenario: First commit touches source
- **WHEN** U1 is pending and the first commit after the start changes `test/limit.test.ts` and `src/limit.ts`
- **THEN** `unit_finish U1` refuses, names `src/limit.ts`, and the attempt count is unchanged

#### Scenario: Test-only commit becomes the pre
- **WHEN** U1 is pending, the first commit after the start adds only `test/limit.test.ts`, `Verify` fails at that commit, and a later commit makes `Verify` pass
- **THEN** the receipt records the test-only commit as `pre.sha` with its non-zero exit

### Requirement: Unit finish tool
`unit_finish` SHALL take only a unit id and SHALL be the only tool that ticks a unit.

A unit is **started** when its latest own `unit-start` comment is newer than its latest own `receipt` and its status line is pending. A unit is **receipted, not ticked** when its latest receipt is newer than its latest `unit-start`, matches its current digest, and its status line is pending. Before any other check, `unit_finish` MUST refuse, writing nothing, when the unit has an unresolved blocking finding (see `review-findings`), or when the pack's non-advisory unit-reviewer entry holds for the unit (evaluated without `context>=N%` conditions) and no completed unit review (see `review-findings`) records the reviewed commit. The reviewed commit SHALL be HEAD; for a unit that ran in a lane and was merged, it SHALL be the lane head that the merge commit at HEAD brought in as its second parent. Findings of an advisory entry MUST NOT refuse a tick. For a receipted, not-ticked unit, `unit_finish` SHALL only tick the unit, without running `Verify` and without posting another receipt, provided the tree is clean and the unit is neither frozen nor stale. Otherwise it MUST refuse, writing nothing, when:
- the unit is not started;
- the unit is frozen or stale, or its digest differs from the digest in its `unit-start` comment;
- the unit has an open lane (it names `lane_merge` as the next step);
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

#### Scenario: Open lane refuses finish
- **WHEN** U2's lane is open and `unit_finish U2` is called
- **THEN** it refuses, names `lane_merge`, and writes nothing

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

### Requirement: Receipt
A `receipt` comment SHALL be an own marked comment of kind `receipt` with id `U<n>.<suffix>` and data:
- `unit` and `digest`;
- `verify` (the command);
- `pre: { sha, exit }` and `post: { sha, exit }`;
- `output`, the tail of the post run's combined output, at most 8 KB, cut on a UTF-8 boundary and marked when truncated;
- `start`, the id of the matching `unit-start` comment.

A receipt MUST NOT be edited after it is posted.

#### Scenario: Output tail
- **WHEN** a green post run prints 20 KB
- **THEN** the receipt's `output` holds the last 8 KB or less, begins with a truncation mark, and is valid UTF-8

#### Scenario: Token redacted
- **WHEN** the post run prints the forge token
- **THEN** the receipt's `output` does not contain the token

### Requirement: Unit attempts and blocked units
`unit_attempts.U<n>` SHALL be derived as the number of `progress.U<n>` decision records newer than all of these:
- the unit's latest `unit-start` comment;
- its latest receipt;
- the latest stuck answer that lifts its block.

A `counter` comment for `unit_attempts.*` MUST be ignored.

A unit SHALL be blocked when, with no lifting stuck answer newer than the event, either:
- its attempts reached `loops.unit_attempts`;
- its latest `progress` record has outcome `stop`.

A stuck answer SHALL lift the block of every unit blocked before it when the answer has outcome `approved` or `approved_with_notes` and a chosen option. A dismissed stuck answer MUST NOT lift a block. While a unit is blocked, `unit_start` and `unit_finish` MUST refuse it and say to send a stuck report with `spec_stuck`, and `unit_finish`'s result SHALL link the unit's receipts and failed-attempt records.

#### Scenario: Cap reached
- **WHEN** `loops.unit_attempts` is 3 and U1's three post runs fail with a different signature each time
- **THEN** U1 is blocked with reason `attempts`, and `unit_finish U1` refuses and says to send a stuck report

#### Scenario: Chosen stuck answer restarts the budget
- **WHEN** U1 is blocked and a stuck report sent afterwards is answered with outcome `approved` and choice `B`
- **THEN** U1 is no longer blocked and `unit_attempts.U1` is 0

#### Scenario: Dismissed stuck answer keeps the block
- **WHEN** U1 is blocked and the only stuck answer after it is dismissed
- **THEN** U1 stays blocked

### Requirement: Verify red on base check
The check `verify-red-on-base` SHALL be registered as a waivable, gate-only check. For each unit, it SHALL run `Verify` on `Base` in a temporary worktree that is removed afterwards, whatever the outcome, and SHALL report:
- an error when a unit that is not a refactor unit is not `red`, or a refactor unit is not `green`, naming the unit and the exit code;
- an error naming the reason when the run is `invalid`;
- an error when no livespec session can provide the environment to run `Verify`, so the gate cannot pass unverified;
- a warning `verifier pending` for a unit that is not a refactor unit and whose test file does not exist on `Base`, exempt from the red requirement;
- an error for a refactor unit whose test file does not exist on `Base`, saying that a refactor needs an existing test.

The temporary worktree SHALL be prepared by running `verify.setup` from the project config when it is set; a failed setup makes the run `invalid`. When `verify.setup` is not set, each of `node_modules`, `.venv` and `vendor` that exists in the main worktree and is git-ignored there SHALL be symlinked into the temporary worktree. Results SHALL be memoized per project root, `Base`, unit id and unit digest for the session. A new session MUST run the check again.

#### Scenario: Green on base refuses the plan gate
- **WHEN** U2's `Verify` exits 0 on `Base` and `spec_gate plan` runs
- **THEN** `verify-red-on-base` reports an error for U2, and the human gate offers `waive` for it

#### Scenario: Pending unit exempt
- **WHEN** U1 is not a refactor unit and its test file does not exist on `Base`
- **THEN** `verify-red-on-base` reports a `verifier pending` warning for U1 and no error

#### Scenario: Refactor without a test
- **WHEN** U2 has `Kind: refactor` and its test file does not exist on `Base`
- **THEN** `verify-red-on-base` reports an error for U2; and when the test exists and `Verify` exits 0 on `Base`, it reports no result for U2

#### Scenario: Missing toolchain is not red
- **WHEN** `Verify` exits 127 on `Base` because a tool is missing
- **THEN** `verify-red-on-base` reports an error for that unit saying the command could not run

#### Scenario: Dependencies linked
- **WHEN** `verify.setup` is not set and the main worktree has an ignored `node_modules`
- **THEN** the temporary worktree has a `node_modules` symlink to it while `Verify` runs, and the temporary worktree no longer exists afterwards

#### Scenario: Memoized
- **WHEN** `spec_gate plan` runs twice with the same `Base` and unit digests
- **THEN** each unit's `Verify` runs on `Base` only once

### Requirement: Work in progress from started units
`livespec` SHALL register a work-in-progress predicate that is busy when an open `livespec` change in phase `build` has a started unit, and names that change and unit. A change in `build` with pending units and no started unit MUST NOT count as work in progress.

#### Scenario: Started unit blocks upgrades
- **WHEN** change #7 in `build` has U2 started and upstream has a compatible new commit
- **THEN** nothing is installed and the skip reason names #7 and U2

#### Scenario: Between units
- **WHEN** change #7 in `build` has U1 done, U2 pending, and no started unit
- **THEN** an automatic upgrade may install
