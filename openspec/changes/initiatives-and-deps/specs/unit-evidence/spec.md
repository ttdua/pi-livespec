## MODIFIED Requirements

### Requirement: Unit start tool
`unit_start` SHALL take only a unit id. When a lane is open for the unit (see `parallel-lanes`), every check on the working tree, HEAD and `Verify` SHALL use the lane worktree; otherwise they use the change worktree. It MUST refuse, writing nothing, in each of these cases, checked in this order:
- the change is not in a `per: unit` phase;
- the change is parked (discovered-dependencies "Parked state");
- no unit lock exists;
- the unit is unknown or done;
- the unit is frozen or stale;
- a unit in its `Depends` is not done;
- the unit is blocked;
- the unit is already started with its current digest;
- the working tree is dirty;
- another unit is started in the same worktree;
- the guard blocks its `Verify` command.

Otherwise it SHALL record HEAD as the pre SHA. For a unit that is not verifier pending, it SHALL then run `Verify` at HEAD and require a valid red, or a green for a `Kind: refactor` unit or a **rebuild**. A `unit-start` older than an own `parked` record that lists its unit SHALL NOT count as started, and that unit's attempt budget SHALL start at that `parked` record. A unit SHALL be **resumed** when an own `parked` record newer than its latest `unit-start` lists it and a resume `parked` record follows that record; a resumed unit started green SHALL record verdict `resumed`. A unit SHALL be a rebuild when its latest own `rebuild` comment is newer than its latest receipt and its latest `unit-start`; a rebuild started green SHALL record verdict `rebuild`, and a red or invalid run SHALL still be accepted or refused as for any other unit. When the run has the wrong class, the tool MUST refuse, write nothing, and name the class, the exit code and the options: a regression pin or a drop through `unit_amend`, or a fixed `Verify`. On success it SHALL post one own `unit-start` comment with the unit, its digest, the `Verify` command, the pre SHA, the pre exit code, the verdict and the redacted output tail.

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

#### Scenario: Rebuild starts green
- **WHEN** U2 was ticked with a receipt for its current digest, review round 1 routed a confirmed `WARNING` to U2, the change returned to `build`, and `Verify` exits 0 at HEAD
- **THEN** `unit_start U2` posts a `unit-start` comment with verdict `rebuild`

#### Scenario: Restart after an amendment
- **WHEN** U1 is started and an approved amendment changes U1's `Verify`
- **THEN** `unit_start U1` runs again with the new `Verify` and posts a new `unit-start` comment

#### Scenario: Parked change refuses
- **WHEN** the change is parked and `unit_start U3` runs
- **THEN** the tool refuses, names the parked state, and posts nothing

#### Scenario: Resumed unit starts green
- **WHEN** U2 was started red, the change was parked with U2's wip branch and resumed, and U2's `Verify` exits 0 at HEAD
- **THEN** `unit_start U2` posts a `unit-start` comment with verdict `resumed`
