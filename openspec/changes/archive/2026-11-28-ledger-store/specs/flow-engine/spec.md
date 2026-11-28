## MODIFIED Requirements

### Requirement: Change state from issue and git
The engine SHALL build `changeState` only from the change issue, the pull request its `PR` line names, the change's ledger, and git:
- from the issue: the phase label, the parsed body, own marked comments, unit status lines and Questions;
- from the ledger: its entries, read from the local ref without fetching except for the first fetch of ledger-store "Ledger fetched before use", and whether a sync is pending;
- from the pull request: its number, its state, whether it is merged and when;
- from git: the current branch, HEAD, a clean or dirty tree, the diff of `specs/` from `Base` to HEAD, and the pushed head `refs/remotes/origin/<branch>` when it exists.

From the own records, the own marked comments and ledger entries merged as ledger-store "Ledger records in the change state" defines, it SHALL derive pending approver requests, gate results, the unit lock with frozen and stale units, stale phases, an unanswered stuck report, the `change_iterations` state, started units, receipts, unit attempts, blocked units, receipted units that are not yet ticked, and the items of the latest `incomplete` comment. It MUST NOT use session memory as a source of state. When the forge is in read-only mode, the state MUST be built from cached data and marked stale. A `PR` line whose pull request cannot be read SHALL leave the pull request state absent and add a warning naming it. A pending ledger sync SHALL add a warning.

#### Scenario: State from fixture issue
- **WHEN** the snapshot is read for an issue with label `livespec:phase/build`, unit U1 done and U3 pending, and a dirty tree
- **THEN** `changeState` has phase `build`, U1 done, U3 pending, and `dirty: true`

#### Scenario: Stale state
- **WHEN** the forge is unreachable and the issue is cached
- **THEN** `changeState` is built from the cache and marked stale

#### Scenario: Ambiguous phase
- **WHEN** the issue carries two `livespec:phase/*` labels
- **THEN** `changeState` reports `phase-ambiguous` with both phases

#### Scenario: Pending request and lock from comments
- **WHEN** the issue has an own approved plan `gate` comment locking U1 and U2, U2's body differs from its locked digest, and an own `request` comment for `question:Q4` has no answer
- **THEN** `changeState` shows U2 frozen and a pending request for `question:Q4`

#### Scenario: Started unit from comments
- **WHEN** the ledger has a `unit-start` entry for U2 and no later `receipt` entry for U2, and U2 is pending
- **THEN** `changeState` shows U2 started

#### Scenario: Done unit is never started
- **WHEN** U2 has a `unit-start` entry and no receipt, and a human ticked U2 on the web
- **THEN** `changeState` does not show U2 started

#### Scenario: Pull request state
- **WHEN** the issue has `PR: #41` and pull request 41 is merged
- **THEN** `changeState` holds pull request 41 as merged, with its merge time

#### Scenario: Unreadable pull request
- **WHEN** the issue has `PR: #41` and reading pull request 41 fails
- **THEN** `changeState` holds no pull request state and a warning names #41

### Requirement: Loop counters
Loop counters SHALL be ledger entries of kind `counter` with id `<loop>` or `<loop>.<unit>` and data `{ value }`. Setting a counter SHALL append a new entry; the latest entry for an id SHALL win. A loop MAY instead be counted from other own records:
- `change_iterations` SHALL be the number of own `stale` comments marked as a counted return to define after a plan approval;
- `unit_attempts.<unit>` SHALL be derived from `progress` decision records, as unit-evidence "Unit attempts and blocked units" defines;
- `review_rounds` SHALL be derived from aggregate review records, as review-phase "Review round cap" defines;
- `discovered_deps` SHALL be derived from `new-dependency` gate results, as discovered-dependencies "Discovered dependencies counter" defines.

A `counter` entry for a derived loop MUST be ignored. The engine SHALL report each counter with its cap from the pack's `loops`.

#### Scenario: Counter shown with cap
- **WHEN** a `counter` entry `custom_loop` has value 1 and the pack sets `loops.custom_loop: 2`
- **THEN** `nextStep` reports `custom_loop` as 1 of 2

#### Scenario: Derived discovered dependencies
- **WHEN** the issue has one valid approved `new-dependency` gate result with choice `A` and a `counter` entry `discovered_deps` with value 9
- **THEN** `nextStep` reports `discovered_deps` as 1 of 2

#### Scenario: Derived review rounds
- **WHEN** the issue has two aggregate review records and a `counter` entry `review_rounds` with value 9
- **THEN** `nextStep` reports `review_rounds` as 2 of 3

#### Scenario: Counter update edits in place
- **WHEN** a counter that already has an entry is set to a new value
- **THEN** a new `counter` entry is appended, the earlier one is unchanged, and the counter reads the new value

#### Scenario: Derived iteration count
- **WHEN** the issue has two own `stale` comments marked as counted returns to define and one that is not
- **THEN** `nextStep` reports `change_iterations` as 2 of 5

#### Scenario: Derived unit attempts
- **WHEN** U2 has two `progress.U2` records after its latest `unit-start`, and a `counter` entry `unit_attempts.U2` with value 9
- **THEN** `nextStep` reports `unit_attempts.U2` as 2 of 3

### Requirement: Comments cache
The engine SHALL cache the raw comments of a change issue and reuse them while the issue's `updatedAt` is unchanged, for at most 5 minutes, and MUST drop the entry after any livespec forge write to that issue; a ledger append is not a forge write and SHALL NOT drop it. Own marked comments MUST be filtered from the cached comments by the current `whoami` login on every read, never stored pre-filtered.

#### Scenario: Comments cache hit
- **WHEN** the snapshot is read twice within 5 minutes and the issue's `updatedAt` did not change
- **THEN** comments are listed from the forge only once

#### Scenario: Account switch
- **WHEN** a `stale` comment was written by account A, the cache is warm, and the current login becomes B with the same issue `updatedAt`
- **THEN** the `stale` comment of A is not counted for B

#### Scenario: Own write invalidates
- **WHEN** `skill_note` posts a comment and the snapshot is read again
- **THEN** comments are listed from the forge again and the new note is present
