# parallel-lanes Specification

## Purpose

Defines parallel lanes: when ready units may run together, the lane worktree and its `lane` record, the `lane_open` and `lane_merge` tools, merging one lane at a time, and the sequential re-run when a lane goes wrong.

## Requirements

### Requirement: Parallel eligibility
Ready units SHALL run in parallel lanes only when a capable executor is present, there is no `Depends` path between them, their `Files` do not overlap, and they edit no shared spec file. At most `lanes` (user config, default 3) lanes SHALL run at once. The pack MUST NOT set a lane count.

#### Scenario: Overlapping files
- **WHEN** U2 and U3 are ready and both list `src/api/x.ts`
- **THEN** they do not run in parallel

#### Scenario: Lane limit
- **WHEN** five independent units are ready and `lanes` is 3
- **THEN** three lanes run and two units wait

### Requirement: Lane worktree
Each lane SHALL be a git worktree at `.worktrees/<change>--<unit>` on branch `livespec/<change>--lane-<unit>`, created from the change branch's HEAD. `unit_start` SHALL run in the lane and record the pre SHA there. Opening a lane SHALL post an own `lane` comment (a marker kind this capability registers) with the unit, path, branch and base SHA, and closing it SHALL post a `lane` comment with `closed: true`. A unit's lane is open when its latest `lane` comment is not closed; `unit_start`, `unit_finish` and dispatch SHALL resolve the unit's worktree from that record, never from a `unit-start` ledger entry. The implementer launch SHALL pass the lane path as `cwd` and `lane` in its metadata. The system MUST NOT register a workspace provider.

#### Scenario: Lane created
- **WHEN** U2 starts in a lane of change `per-ip-cap`
- **THEN** the worktree `.worktrees/per-ip-cap--U2` exists on `livespec/per-ip-cap--lane-U2`, an open `lane` comment records it, and the launch's `cwd` is that path

### Requirement: Merge one at a time
When a lane's unit has passed review, the parent SHALL merge the lane with `lane_merge`, run `unit_finish` for the unit on the change branch, and only then merge the next finished lane. `lane_merge` SHALL merge the lane branch into the change branch with `git merge --no-ff`, run `Verify` on the change worktree, close the lane record and remove the lane worktree and branch, so `unit_finish` runs on the change worktree. The lane head stays reachable as the merge commit's second parent.

#### Scenario: Two lanes finish
- **WHEN** U2's and U3's lanes both pass review
- **THEN** U2 is merged and ticked on the change branch before U3 is merged

### Requirement: Lane tools
`lane_open <unit>` SHALL open a lane for one ready unit and `lane_merge <unit>` SHALL merge it; both are parent tools and MUST refuse in a child session. `lane_open` MUST refuse, writing nothing, when no capable executor is present, the unit is not ready, the unit is already started, its lane would break "Parallel eligibility" against the open lanes, or `lanes` lanes are already open. A leftover worktree at the lane path SHALL be reused when its HEAD equals the change branch HEAD and its tree is clean, and refused naming its path otherwise. `lane_merge` MUST refuse when the unit has no open lane, the change worktree is dirty, or the unit's review step is not done at the lane head. In `build`, the next step SHALL name `lane_open` for each eligible ready unit when two or more ready units are eligible together and the implementer entry holds, and SHALL name `lane_merge` for a lane unit whose review step is done.

#### Scenario: Next step opens lanes
- **WHEN** U2 and U3 are ready, independent and have disjoint `Files`, the implementer entry holds and a capable executor is present
- **THEN** the next step names `lane_open U2` and `lane_open U3`

#### Scenario: Open refused over the limit
- **WHEN** `lanes` is 1, U2's lane is open and `lane_open U3` is called
- **THEN** the tool refuses, names the limit, and nothing is created or posted

#### Scenario: Leftover worktree
- **WHEN** `.worktrees/per-ip-cap--U2` exists with a HEAD other than the change branch HEAD
- **THEN** `lane_open U2` refuses naming that path

#### Scenario: Merge before review refused
- **WHEN** U2's lane is open and no completed unit review covers the lane head
- **THEN** `lane_merge U2` refuses and names the unit review as the next step

### Requirement: Sequential re-run
The unit SHALL be re-run sequentially on the change branch, and its lane removed, when:
- the lane's commits touch a file outside the unit's `Files`, and a `files-violation` finding SHALL be recorded for the next plan review or amendment;
- the merge conflicts, and the merge SHALL be aborted;
- `Verify` is green in the lane but red after the merge, which SHALL count as a failed attempt;
- the child's effective `cwd` differs from the lane.

#### Scenario: Files violation
- **WHEN** U2's lane commits change `src/other.ts`, which is not in U2's `Files`
- **THEN** `lane_merge U2` merges nothing, posts a `files-violation` finding, closes and removes the lane, and the next step runs U2 sequentially

#### Scenario: Red after merge
- **WHEN** U3 is green in its lane and `Verify` is red on the change branch after the merge
- **THEN** `lane_merge U3` undoes the merge, posts a failed attempt for U3, closes and removes the lane, and the next step runs U3 sequentially

#### Scenario: Moved by a workspace provider
- **WHEN** U2's child reports a `cwd` other than its lane
- **THEN** the child is aborted and U2 re-runs sequentially
