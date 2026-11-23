## MODIFIED Requirements

### Requirement: Guarded push
The package SHALL provide `guardedPush` as the only code path that runs `git push`. It MUST NOT be reachable from any tool parameter, command or environment variable that the agent controls: the remote SHALL always be `origin` and the refspec SHALL always be `HEAD:refs/heads/<branch>`, where `<branch>` is the change issue's `Branch` line for `change_ship` and `change_push`, the checked-out fix branch for `fix_ship`, and `<Branch line>--wip-<unit>` for `change_park`, with `<unit>` a unit id of the change issue. Only `change_ship`, `change_push`, `fix_ship` and `change_park` SHALL call it, and only after their refusal checks pass (see ship-phase, small-fix-lane and discovered-dependencies).

#### Scenario: No tool calls the push path
- **WHEN** the sources under `src/tools/` are scanned
- **THEN** no tool other than `change-ship.ts`, `change-push.ts`, `fix-ship.ts` and `change-park.ts` imports the guarded push module

#### Scenario: Refspec from the issue
- **WHEN** `change_ship` pushes for a change whose `Branch` line is `livespec/rate-limit`
- **THEN** `guardedPush` runs `git push -- origin HEAD:refs/heads/livespec/rate-limit` and no tool parameter changes the remote or the refspec

#### Scenario: Refspec from the fix branch
- **WHEN** `fix_ship` pushes on the checked-out branch `fix/typo`
- **THEN** `guardedPush` runs `git push -- origin HEAD:refs/heads/fix/typo`

#### Scenario: Refspec of a wip branch
- **WHEN** `change_park` parks U2 of a change whose `Branch` line is `livespec/rate-limit`
- **THEN** `guardedPush` runs `git push -- origin HEAD:refs/heads/livespec/rate-limit--wip-U2` from U2's worktree
