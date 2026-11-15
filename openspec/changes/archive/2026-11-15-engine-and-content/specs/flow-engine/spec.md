## ADDED Requirements

### Requirement: Change state from issue and git
The engine SHALL build `changeState` only from the change issue (phase label, parsed body, own marked comments, unit status lines and Questions) and from git (current branch, HEAD, clean or dirty tree, and the diff of `specs/` from `Base` to HEAD). It MUST NOT use session memory as a source of state. When the forge is in read-only mode, the state MUST be built from cached data and marked stale.

#### Scenario: State from fixture issue
- **WHEN** the snapshot is read for an issue with label `livespec:phase/build`, unit U1 done and U3 pending, and a dirty tree
- **THEN** `changeState` has phase `build`, U1 done, U3 pending, and `dirty: true`

#### Scenario: Stale state
- **WHEN** the forge is unreachable and the issue is cached
- **THEN** `changeState` is built from the cache and marked stale

#### Scenario: Ambiguous phase
- **WHEN** the issue carries two `livespec:phase/*` labels
- **THEN** `changeState` reports `phase-ambiguous` with both phases

### Requirement: Next step
`nextStep(pack, changeState)` SHALL be a pure function. It returns the current phase, the required and optional skills, the redirects, outstanding check results, open blocking questions, counters with their caps, active units, `incomplete` markers, an optional phase to advance to, and exactly one sentence saying what to do next.

#### Scenario: Pure
- **WHEN** `nextStep` is called twice with equal inputs
- **THEN** both results are deeply equal and no I/O is performed

### Requirement: Next step precedence
`nextStep` SHALL only be called with a valid pack; the caller reports pack errors instead (see flow-pack). The next-step sentence MUST follow this precedence: missing or ambiguous phase label; change not started after `shape`; open blocking question; missing phase output; failing check; in `build`, the next pending unit whose `Depends` are done, or the blocked units when none is ready; then the phase gate. In the last phase of the flow, the sentence MUST say the flow has no further phase.

#### Scenario: No unit ready
- **WHEN** the change is in `build` and every pending unit depends on another pending unit
- **THEN** the next sentence names the blocked units and their unmet `Depends`, and no advance is reported

#### Scenario: Last phase
- **WHEN** the change is in `close`
- **THEN** the next sentence says the flow has no further phase and no advance is reported

#### Scenario: Blocking question first
- **WHEN** the change is in `define` with an open blocking question Q1 and a failing `spec-format` check
- **THEN** the next sentence asks to answer Q1

#### Scenario: Missing output
- **WHEN** the change is in `define`, started, with no open blocking question and an empty `## Proposal`
- **THEN** the next sentence asks to write the Proposal with `spec_write`

#### Scenario: Not started
- **WHEN** the change is in `define` and its issue has no `Branch` line
- **THEN** the next sentence asks to run `change_start`

#### Scenario: Next unit
- **WHEN** the change is in `build`, U1 is done and U3 depends on U1 and is pending
- **THEN** the next sentence names U3

#### Scenario: Human gate ready
- **WHEN** the change is in `plan`, every output is present and every check passes
- **THEN** the next sentence says the change is ready for the `plan` gate

### Requirement: Successor phase
The successor of a phase SHALL be the first phase, in pack order, whose `requires` include it. A phase with no successor is the last phase. A `gate: none` phase SHALL report its successor as the phase to advance to only when no earlier rule of the precedence applies; for a `per: unit` phase that means every unit is done.

#### Scenario: Build with pending units does not advance
- **WHEN** the change is in `build` (gate `none`), all checks pass, and U3 is pending and ready
- **THEN** the next sentence names U3 and no advance is reported

#### Scenario: Branching custom pack
- **WHEN** a pack has phases `docs` and `review` that both require `build`, with `review` listed first
- **THEN** the successor of `build` is `review`, and a completed `build` reports `review` as the phase to advance to

#### Scenario: Completed build with a human gate
- **WHEN** an override sets `build` to `gate: human` and every unit of a change in `build` is done
- **THEN** the next sentence says the change is ready for the `build` gate and no advance is reported

#### Scenario: Custom successor
- **WHEN** a pack lists phase `docs` requiring `build` before `review`, and every unit of a change in `build` is done
- **THEN** `docs` is reported as the phase to advance to

### Requirement: Named checks over LS-02 validators
The engine SHALL register the named checks `spec-format` (living spec validation of the capabilities the change declares), `units-format`, `done-maps-scenarios` and `capabilities-match-diff`, each returning the LS-02 `Result` list. The engine SHALL run only the checks the active phase lists, and later specs MUST be able to register more checks.

#### Scenario: Units check in plan
- **WHEN** the change is in `plan` and unit U2 lacks `Verify`
- **THEN** the outstanding checks contain a `units-format` error for U2

#### Scenario: Only active phase checks
- **WHEN** the change is in `shape`
- **THEN** no check is run

#### Scenario: Capabilities mismatch
- **WHEN** the change declares `modified [rate-limit]` and the diff from `Base` touches only `specs/auth/`
- **THEN** `capabilities-match-diff` reports both mismatches

### Requirement: Loop counters
Loop counters SHALL be tool-written marked comments of kind `counter` with id `<loop>` or `<loop>.<unit>` and data `{ value }`. Setting a counter MUST edit the existing own counter comment or create one when none exists. The engine SHALL report each counter with its cap from the pack's `loops`.

#### Scenario: Counter shown with cap
- **WHEN** a `counter` comment `review_rounds` has value 2 and the pack cap is 3
- **THEN** `nextStep` reports `review_rounds` as 2 of 3

#### Scenario: Counter update edits in place
- **WHEN** a counter that already has an own comment is set to a new value
- **THEN** that comment is edited and no new comment is created

### Requirement: Comments cache
The engine SHALL cache the raw comments of a change issue and reuse them while the issue's `updatedAt` is unchanged, for at most 5 minutes, and MUST drop the entry after any livespec write to that issue. Own marked comments MUST be filtered from the cached comments by the current `whoami` login on every read, never stored pre-filtered.

#### Scenario: Comments cache hit
- **WHEN** the snapshot is read twice within 5 minutes and the issue's `updatedAt` did not change
- **THEN** comments are listed from the forge only once

#### Scenario: Account switch
- **WHEN** a counter comment was written by account A, the cache is warm, and the current login becomes B with the same issue `updatedAt`
- **THEN** the counter of A is not counted for B

#### Scenario: Own write invalidates
- **WHEN** `skill_note` posts a comment and the snapshot is read again
- **THEN** comments are listed from the forge again and the new note is present

### Requirement: Skill notes
The marker kind `skill-note` SHALL be registered. The `skill_note` tool SHALL accept a skill name and a one-line reason of 1 to 200 characters, and SHALL post a `skill-note` comment with id `<phase>.<skill>` only when the skill is in the active phase's `skills.optional`. The phase card MUST remind the agent to record a note for every optional skill it read in the session without a note.

#### Scenario: Note posted
- **WHEN** the change is in `build` and `skill_note` is called with `debugging-and-error-recovery` and a one-line reason
- **THEN** a `skill-note` comment `build.debugging-and-error-recovery` is posted with the reason

#### Scenario: Not optional
- **WHEN** `skill_note` is called with a required skill or a skill not in the phase
- **THEN** the tool refuses and posts nothing

#### Scenario: Reminder
- **WHEN** the agent read the `SKILL.md` of optional skill `code-simplification` in `review` and no note exists
- **THEN** the phase card lists `code-simplification` as needing a skill note

### Requirement: Advance phase
`advancePhase(change, to)` SHALL move the `livespec:phase/<phase>` label forward to a phase whose `requires` include the current phase, or back to any earlier phase, and MUST refuse any other move. It MUST add the new label before removing the old one, so a failure never leaves the issue with no phase label. When `nextStep` reports a phase to advance to, the session SHALL move the change there with `advancePhase` while the forge is writable.

#### Scenario: Forward move
- **WHEN** `advancePhase` moves a change from `define` to `plan`
- **THEN** the issue has label `livespec:phase/plan` and not `livespec:phase/define`

#### Scenario: Skip refused
- **WHEN** `advancePhase` is asked to move from `define` to `build`
- **THEN** it refuses and the labels are unchanged

#### Scenario: Partial failure
- **WHEN** adding the new label succeeds and removing the old one fails
- **THEN** the issue keeps both labels and the next snapshot reports `phase-ambiguous`

#### Scenario: Build complete
- **WHEN** the snapshot shows phase `build` of the default pack with every unit done and the forge is writable
- **THEN** the change is moved to `review`, the successor of `build`

### Requirement: Advance phase is idempotent
`advancePhase` MUST be idempotent. With exactly one phase label that is not the target, it SHALL perform the normal move. With only the target label, it SHALL succeed without a write. With exactly the target label and one other phase label, it SHALL remove the other one. With no phase label or with other combinations, it MUST refuse with a repair hint.

#### Scenario: Normal move unaffected
- **WHEN** the issue carries only `livespec:phase/define` and the target is `plan`
- **THEN** the normal forward move is performed

#### Scenario: Retry completes the move
- **WHEN** the issue carries `livespec:phase/define` and `livespec:phase/plan` and `advancePhase` is called again with target `plan`
- **THEN** only `livespec:phase/plan` remains

#### Scenario: Already moved
- **WHEN** the issue carries only the target label
- **THEN** `advancePhase` succeeds and makes no forge call that writes

#### Scenario: Three phase labels
- **WHEN** the issue carries three phase labels
- **THEN** `advancePhase` refuses with a repair hint and changes nothing

### Requirement: Integration branch
The integration branch SHALL be the project config key `integrationBranch` or, when unset, the default branch of `origin` read from git. Change branches MUST be created from it. Updates from it MUST be merges and never rebases, and the routing note SHALL state that rule.

#### Scenario: Config wins
- **WHEN** the project config sets `integrationBranch: develop`
- **THEN** `change_start` creates the branch from `origin/develop`

#### Scenario: Default branch
- **WHEN** no `integrationBranch` is set and `origin/HEAD` points at `main`
- **THEN** the integration branch is `main`

#### Scenario: Cannot resolve
- **WHEN** no `integrationBranch` is set and `origin/HEAD` is not set
- **THEN** the tool refuses and asks the user to set `integrationBranch`
