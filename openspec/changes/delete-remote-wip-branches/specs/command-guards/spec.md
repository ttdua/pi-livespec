## MODIFIED Requirements

### Requirement: Guarded push
The package SHALL provide `guardedPush` and the guarded wip delete, in one module, as the only code paths that run `git push`. `guardedPush` MUST NOT be reachable from any tool parameter, command or environment variable that the agent controls: the remote SHALL always be `origin` and the refspec SHALL always be `HEAD:refs/heads/<branch>`, where `<branch>` is the change issue's `Branch` line for `change_ship` and `change_push`, the checked-out fix branch for `fix_ship`, and `<Branch line>--wip-<unit>` for `change_park`, with `<unit>` a unit id of the change issue. Only `change_ship`, `change_push`, `fix_ship` and `change_park` SHALL call it, and only after their refusal checks pass (see ship-phase, small-fix-lane and discovered-dependencies).

The guarded wip delete SHALL be the only code path that deletes a remote branch. It SHALL always target `origin` and delete with `git push --force-with-lease=refs/heads/<branch>:<head> -- origin :refs/heads/<branch>`, where `<head>` is the head the `parked` record lists for that unit; it SHALL read the remote ref by its exact name `refs/heads/<branch>` and ignore any other ref. It MUST NOT be reachable from any agent-controlled input, and it SHALL itself refuse, without running git, a branch name without `--wip-` or one starting with `-`. Only `change_resume` SHALL call it, only after its wip merges succeed, and only with a branch it rebuilt as `<Branch line>--wip-<unit>` from the change issue's `Branch` line and one of its unit ids (see discovered-dependencies "Resume tool").

#### Scenario: No tool calls the push path
- **WHEN** the sources under `src/tools/` are scanned
- **THEN** no tool other than `change-ship.ts`, `change-push.ts`, `fix-ship.ts`, `change-park.ts` and `change-resume.ts` imports the guarded push module, and only `change-resume.ts` uses the guarded wip delete

#### Scenario: Refspec from the issue
- **WHEN** `change_ship` pushes for a change whose `Branch` line is `livespec/rate-limit`
- **THEN** `guardedPush` runs `git push -- origin HEAD:refs/heads/livespec/rate-limit` and no tool parameter changes the remote or the refspec

#### Scenario: Refspec from the fix branch
- **WHEN** `fix_ship` pushes on the checked-out branch `fix/typo`
- **THEN** `guardedPush` runs `git push -- origin HEAD:refs/heads/fix/typo`

#### Scenario: Refspec of a wip branch
- **WHEN** `change_park` parks U2 of a change whose `Branch` line is `livespec/rate-limit`
- **THEN** `guardedPush` runs `git push -- origin HEAD:refs/heads/livespec/rate-limit--wip-U2` from U2's worktree

#### Scenario: Delete of a wip branch
- **WHEN** `change_resume` deletes U2's wip branch of a change whose `Branch` line is `livespec/rate-limit`, parked at head `<h>`
- **THEN** the only push it runs is `git push --force-with-lease=refs/heads/livespec/rate-limit--wip-U2:<h> -- origin :refs/heads/livespec/rate-limit--wip-U2`

#### Scenario: Delete refuses a non-wip branch
- **WHEN** the guarded delete is called with `livespec/rate-limit` or `main`
- **THEN** it throws without running `git push`
