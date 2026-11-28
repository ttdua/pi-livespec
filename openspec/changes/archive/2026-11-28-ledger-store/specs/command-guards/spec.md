## MODIFIED Requirements

### Requirement: Guarded push
The package SHALL provide `guardedPush`, the guarded wip delete and the guarded ledger operations, in one module, as the only code paths that run `git push`, and the guarded ledger fetch as the only code path that fetches `refs/livespec/*`. `guardedPush` MUST NOT be reachable from any tool parameter, command or environment variable that the agent controls: the remote SHALL always be `origin` and the refspec SHALL always be `HEAD:refs/heads/<branch>`, where `<branch>` is the change issue's `Branch` line for `change_ship` and `change_push`, the checked-out fix branch for `fix_ship`, and `<Branch line>--wip-<unit>` for `change_park`, with `<unit>` a unit id of the change issue. Only `change_ship`, `change_push`, `fix_ship` and `change_park` SHALL call it, and only after their refusal checks pass (see ship-phase, small-fix-lane and discovered-dependencies).

The guarded wip delete SHALL be the only code path that deletes a remote branch. It SHALL always target `origin` and delete with `git push --force-with-lease=refs/heads/<branch>:<head> -- origin :refs/heads/<branch>`, where `<head>` is the head the `parked` record lists for that unit; it SHALL read the remote ref by its exact name `refs/heads/<branch>` and ignore any other ref. It MUST NOT be reachable from any agent-controlled input, and it SHALL itself refuse, without running git, a branch name without `--wip-` or one starting with `-`. Only `change_resume` SHALL call it, only after its wip merges succeed, and only with a branch it rebuilt as `<Branch line>--wip-<unit>` from the change issue's `Branch` line and one of its unit ids (see discovered-dependencies "Resume tool").

The guarded ledger operations SHALL take only a change issue number, which they MUST check is a positive integer, and SHALL always target `origin`:
- fetch: `git fetch -- origin +refs/livespec/<n>:refs/livespec-origin/<n>`;
- push: `git push -- origin <commit>:refs/livespec/<n>`, without force, where `<commit>` is the local ledger tip;
- delete: `git push --force-with-lease=refs/livespec/<n>:<tip> -- origin :refs/livespec/<n>`, where `<tip>` is the synced tip.

Only the ledger module SHALL call them. No tool parameter, command or environment variable the agent controls SHALL reach them.

The guard SHALL block any agent `git` command, in the forms "Push and pull request commands" recognises, whose arguments contain `refs/livespec` or `livespec-origin`, unless its subcommand is one of `log`, `show`, `cat-file`, `rev-parse`, `rev-list`, `ls-tree`, `ls-remote`, `for-each-ref` or `diff`. It SHALL also block `git update-ref --stdin`, and `git fetch` or `git push` with a refspec whose destination contains `*` and is not under `refs/remotes/`. The reason SHALL say that the ledger is written only by livespec tools. Writes through other git plumbing (`pack-refs`, `replace`), refspecs taken from git config (`remote.origin.fetch` set with `git config` or `git -c` and a bare `git fetch`), ref names passed through a shell expansion, git subcommands the guard does not model, and direct writes under `.git` are accepted limits, documented in the architecture.

#### Scenario: No tool calls the push path
- **WHEN** the sources under `src/tools/` are scanned
- **THEN** no tool other than `change-ship.ts`, `change-push.ts`, `fix-ship.ts`, `change-park.ts` and `change-resume.ts` imports the guarded push module, only `change-resume.ts` uses the guarded wip delete, and only modules under `src/ledger/` use the guarded ledger operations

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

#### Scenario: Ledger push refspec
- **WHEN** a ledger sync pushes change #59 whose local tip is `<t>`
- **THEN** the only push it runs is `git push -- origin <t>:refs/livespec/59`

#### Scenario: Ledger operations refuse a bad issue number
- **WHEN** a guarded ledger operation is called with `0`, `-1` or `59 --force`
- **THEN** it throws without running git

#### Scenario: Agent ledger writes blocked
- **WHEN** the agent runs `git update-ref refs/livespec/59 HEAD`, `git push origin x:refs/livespec/59`, `git fetch origin refs/livespec/59:refs/livespec/59`, `git update-ref --stdin` or `git fetch origin '+refs/*:refs/*'`
- **THEN** each call is blocked

#### Scenario: Agent ledger reads allowed
- **WHEN** the agent runs `git show refs/livespec/59:findings.jsonl` or `git log refs/livespec/59`
- **THEN** each call is allowed

#### Scenario: Delete refuses a non-wip branch
- **WHEN** the guarded delete is called with `livespec/rate-limit` or `main`
- **THEN** it throws without running `git push`
