## ADDED Requirements

### Requirement: Parallel eligibility
Ready units SHALL run in parallel lanes only when a capable executor is present, there is no `Depends` path between them, their `Files` do not overlap, and they edit no shared spec file. At most `lanes` (user config, default 3) lanes SHALL run at once. The pack MUST NOT set a lane count.

#### Scenario: Overlapping files
- **WHEN** U2 and U3 are ready and both list `src/api/x.ts`
- **THEN** they do not run in parallel

#### Scenario: Lane limit
- **WHEN** five independent units are ready and `lanes` is 3
- **THEN** three lanes run and two units wait

### Requirement: Lane worktree
Each lane SHALL be a git worktree at `.worktrees/<change>--<unit>` on branch `livespec/<change>--lane-<unit>`, created from the change branch's HEAD. `unit_start` SHALL run in the lane and record the pre SHA there. Opening a lane SHALL post an own `lane` comment (a marker kind this capability registers) with the unit, path, branch and base SHA, and closing it SHALL post a `lane` comment with `closed: true`. A unit's lane is open when its latest `lane` comment is not closed; `unit_start`, `unit_finish` and dispatch SHALL resolve the unit's worktree from that record, never from a `unit-start` comment. The implementer launch SHALL pass the lane path as `cwd` and `lane` in its metadata. The system MUST NOT register a workspace provider.

#### Scenario: Lane created
- **WHEN** U2 starts in a lane of change `per-ip-cap`
- **THEN** the worktree `.worktrees/per-ip-cap--U2` exists on `livespec/per-ip-cap--lane-U2`, an open `lane` comment records it, and the launch's `cwd` is that path

### Requirement: Merge one at a time
When a lane's unit has passed review, the parent SHALL merge the lane branch into the change branch with `git merge --no-ff`, run `unit_finish` for the unit on the change branch, and only then merge the next finished lane. The merge SHALL close the lane record before `unit_finish` runs, so `unit_finish` runs on the change worktree; the lane worktree and branch SHALL be removed after its unit is ticked.

#### Scenario: Two lanes finish
- **WHEN** U2's and U3's lanes both pass review
- **THEN** U2 is merged and ticked on the change branch before U3 is merged

### Requirement: Sequential re-run
The unit SHALL be re-run sequentially on the change branch, and its lane removed, when:
- the lane's commits touch a file outside the unit's `Files`, and a `files-violation` finding SHALL be recorded for the next plan review or amendment;
- the merge conflicts, and the merge SHALL be aborted;
- `Verify` is green in the lane but red after the merge, which SHALL count as a failed attempt;
- the child's effective `cwd` differs from the lane.

#### Scenario: Files violation
- **WHEN** U2's lane commits change `src/other.ts`, which is not in U2's `Files`
- **THEN** U2 re-runs sequentially and a `files-violation` finding is posted

#### Scenario: Red after merge
- **WHEN** U3 is green in its lane and `Verify` is red on the change branch after the merge
- **THEN** the merge is undone, U3's attempt count rises by one, and U3 re-runs sequentially

#### Scenario: Moved by a workspace provider
- **WHEN** U2's child reports a `cwd` other than its lane
- **THEN** the child is aborted and U2 re-runs sequentially
