## MODIFIED Requirements

### Requirement: Guarded push
The package SHALL provide `guardedPush` as the only code path that runs `git push`. It MUST NOT be reachable from any tool parameter, command or environment variable that the agent controls: the remote SHALL always be `origin` and the refspec SHALL always be `HEAD:refs/heads/<branch>`, where `<branch>` is the change issue's `Branch` line. Only `change_ship` and `change_push` SHALL call it, and only after their refusal checks pass (see ship-phase).

#### Scenario: No tool calls the push path
- **WHEN** the sources under `src/tools/` are scanned
- **THEN** no tool other than `change-ship.ts` and `change-push.ts` imports the guarded push module

#### Scenario: Refspec from the issue
- **WHEN** `change_ship` pushes for a change whose `Branch` line is `livespec/rate-limit`
- **THEN** `guardedPush` runs `git push -- origin HEAD:refs/heads/livespec/rate-limit` and no tool parameter changes the remote or the refspec
