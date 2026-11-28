## MODIFIED Requirements

### Requirement: Lane worktree
Each lane SHALL be a git worktree at `.worktrees/<change>--<unit>` on branch `livespec/<change>--lane-<unit>`, created from the change branch's HEAD. `unit_start` SHALL run in the lane and record the pre SHA there. Opening a lane SHALL post an own `lane` comment (a marker kind this capability registers) with the unit, path, branch and base SHA, and closing it SHALL post a `lane` comment with `closed: true`. A unit's lane is open when its latest `lane` comment is not closed; `unit_start`, `unit_finish` and dispatch SHALL resolve the unit's worktree from that record, never from a `unit-start` ledger entry. The implementer launch SHALL pass the lane path as `cwd` and `lane` in its metadata. The system MUST NOT register a workspace provider.

#### Scenario: Lane created
- **WHEN** U2 starts in a lane of change `per-ip-cap`
- **THEN** the worktree `.worktrees/per-ip-cap--U2` exists on `livespec/per-ip-cap--lane-U2`, an open `lane` comment records it, and the launch's `cwd` is that path
