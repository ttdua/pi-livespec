# command-guards Specification

## Purpose

Defines the `tool_call` guard. It checks every `bash`, `write` and `edit` call of an initialized livespec project and blocks: forge writes; pushes and pull requests outside livespec tools; obscured commands that carry a dangerous token; and agent writes to `.pi/livespec/`. It also defines `guardedPush`, the only code path that runs `git push`.

## Requirements

### Requirement: Guard hook
In an initialized livespec project, the extension SHALL register a `tool_call` handler that inspects every `bash`, `write` and `edit` call before it runs. It SHALL block a forbidden call with a reason that starts with `livespec guard:`, names the matched rule, and names the livespec tool to use, or says that only a human may do it. The guard MUST fail closed: if it cannot decide, it MUST block, and the reason SHALL say the command was not run. It SHALL run before any other livespec `tool_call` handler. In a project that is not initialized, it MUST allow every call.

#### Scenario: Reason names the tool
- **WHEN** the agent runs `gh issue edit 6 --body-file body.md`
- **THEN** the call is blocked and the reason starts with `livespec guard:` and names `spec_write`

#### Scenario: Guard error blocks
- **WHEN** the classifier throws on a command
- **THEN** the call is blocked and the reason says the guard failed and the command was not run

### Requirement: Forge write commands
The guard SHALL block, whatever wrappers surround them:
- `gh issue` write subcommands (`create`, `edit`, `comment`, `close`, `reopen`, `delete`, `transfer`, `lock`, `unlock`, `pin`, `unpin`);
- `gh pr` write subcommands (`create`, `edit`, `merge`, `comment`, `review`, `close`, `reopen`, `ready`);
- `gh api` with a method other than GET, or with a field or input option and no explicit GET;
- `gh label`, `release`, `repo`, `secret` and `variable` write subcommands;
- `tea` write subcommands;
- `curl` or `wget` with a write method or a request body against a forge endpoint.

The forge endpoints SHALL be the forge target's host and authority, `api.<host>` and `uploads.<host>` for a GitHub target, and every host in config `githubHosts` and `giteaUrl`. Without a target, `github.com`, `api.github.com` and those config hosts are the endpoints.

Read commands, such as `gh issue view`, `gh api` with GET and `tea issues list`, MUST be allowed.

#### Scenario: Manual tick blocked
- **WHEN** the agent runs `gh issue edit 6 --body "…- [x] done…"`
- **THEN** the call is blocked and the issue is unchanged

#### Scenario: Self-approval comment blocked
- **WHEN** the agent runs `gh issue comment 6 --body "/livespec approve"`
- **THEN** the call is blocked

#### Scenario: API write blocked, read allowed
- **WHEN** the agent runs `gh api -X PATCH repos/o/r/issues/6 -f body=x` and then `gh api repos/o/r/issues/6`
- **THEN** the first call is blocked and the second is allowed

#### Scenario: Raw HTTP write to the forge host
- **WHEN** the forge host is `git.example.com` and the agent runs `curl -X POST https://git.example.com/api/v1/repos/o/r/issues/6/comments -d '{}'`
- **THEN** the call is blocked; and `curl -X POST https://example.org/hook` is allowed

#### Scenario: GitHub API host
- **WHEN** the forge target host is `github.com` and the agent runs `curl -X PATCH https://api.github.com/repos/o/r/issues/6 -d '{"body":"x"}'`
- **THEN** the call is blocked

#### Scenario: Tea write blocked
- **WHEN** the agent runs `tea comment 6 "/livespec approve"`
- **THEN** the call is blocked; and `tea issues list` is allowed

### Requirement: Push and pull request commands
The guard SHALL always block, in a livespec project:
- `git push` in any form, including after `git -C <dir>`, `git -c k=v`, `--git-dir`, `--work-tree`, environment prefixes, `env`, `command`, `exec`, `nice`, `nohup`, `time`, `timeout`, `sudo` and `xargs`;
- `git push` inside `sh -c`, `bash -c`, `zsh -c` or `dash -c` scripts and inside `$(…)` or backtick substitutions;
- a git alias that expands to `push`;
- `gh pr create`, `gh pr merge` and `tea pr …` or `tea pulls …` other than `list`.

The reason SHALL say that pushes and pull requests happen only through livespec tools. Wrapper options are recognized in the forms the guard models. A GNU abbreviated long option on a wrapper (`nice --adjust`, `timeout --kill-a`, `env --split-s`, `xargs --max-a`) is an accepted limit, documented in the architecture.

#### Scenario: Push variants blocked
- **WHEN** the agent runs each of `git push`, `git -C . push origin HEAD`, `env GIT_TRACE=1 git push`, `FOO=1 git push`, `sh -c "cd x && git push"`, `bash -c 'git push --force'`, `echo $(git push)`, `xargs git push < /dev/null` and `git -c user.name=x push`
- **THEN** every call is blocked

#### Scenario: Push alias blocked
- **WHEN** git config has `alias.p = push` and the agent runs `git p`
- **THEN** the call is blocked

#### Scenario: Pull request commands blocked
- **WHEN** the agent runs `gh pr create --fill`, `gh pr merge 3` or `tea pr create`
- **THEN** every call is blocked

#### Scenario: Ordinary git allowed
- **WHEN** the agent runs `git status`, `git commit -m "x"`, `git log --oneline` or `git -C sub fetch`
- **THEN** every call is allowed

### Requirement: Obscured commands
The guard SHALL block a bash command that contains a dangerous token (`push`, `gh`, `tea`, a forge endpoint, or `curl` or `wget` together with a forge endpoint, matched as whole words ignoring case) when the command:
- uses `eval`;
- has a parameter expansion or a substitution as its command word;
- has one as the subcommand of `git`, `gh` or `tea`, or as the method or URL argument of `curl` or `wget`, because that word decides the operation;
- cannot be parsed, such as unbalanced quotes.

An expansion in an ordinary argument, such as a commit message or a file name, MUST NOT block by itself.

Running a script file, such as `bash ./x.sh`, SHALL be allowed as an accepted limit.

#### Scenario: Eval blocked
- **WHEN** the agent runs `eval "git push"`
- **THEN** the call is blocked

#### Scenario: Variable git subcommand
- **WHEN** the agent runs `CMD=push; git $CMD`
- **THEN** the call is blocked; and `git commit -m "$MSG"` is allowed

#### Scenario: Variable command word
- **WHEN** the agent runs `X=gh; $X issue comment 6 -b hi`
- **THEN** the call is blocked

#### Scenario: Harmless eval allowed
- **WHEN** the agent runs `eval "$(ssh-agent -s)"`
- **THEN** the call is allowed

#### Scenario: Script file allowed
- **WHEN** the agent runs `bash ./scripts/release.sh`
- **THEN** the call is allowed

### Requirement: Livespec project files
The guard SHALL block agent writes to paths under `<project>/.pi/livespec/`:
- `write` and `edit` calls whose resolved path is under that folder;
- bash redirections into it;
- `tee`, `cp`, `mv`, `rm`, `ln`, `touch`, `install`, `sed -i` and `perl -i` targeting it.

Paths SHALL be resolved against the working directory, following `..` and existing symlinks. Earlier `cd` and `pushd` commands in the same bash command SHALL be taken into account: a target is protected when it resolves under that folder from the starting directory or from any directory an earlier literal `cd` names. After a `cd` whose argument cannot be resolved, a relative target whose path contains `livespec` MUST be blocked. The reason SHALL say that the flow and config of the project are changed by a human. Reads MUST be allowed. A recursive copy or a move into an ancestor of that folder (`cp -r <src>/livespec .pi`) is an accepted limit, documented in the architecture.

#### Scenario: Flow override edit blocked
- **WHEN** the agent calls `edit` on `.pi/livespec/flow.yaml`
- **THEN** the call is blocked and the file is unchanged

#### Scenario: Shell write blocked
- **WHEN** the agent runs `echo "gate: self" >> .pi/livespec/flow.yaml` or `sed -i s/human/self/ ./.pi/livespec/flow.yaml`
- **THEN** each call is blocked

#### Scenario: Path traversal
- **WHEN** the agent calls `write` on `src/../.pi/livespec/config.yaml`
- **THEN** the call is blocked

#### Scenario: Directory change before the write
- **WHEN** the agent runs `cd .pi; echo x > livespec/flow.yaml`, `(cd sub); echo x > .pi/livespec/flow.yaml`, or `cd "$D" && echo x > livespec/flow.yaml`
- **THEN** each call is blocked; and `cd src && echo x > out.txt` is allowed

#### Scenario: Read allowed
- **WHEN** the agent runs `cat .pi/livespec/flow.yaml`
- **THEN** the call is allowed

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

### Requirement: Bare work
When neither a `livespec/*` change branch nor a fix branch is checked out, a `write` or `edit` call whose resolved path is a tracked file of the project outside `specs/` and outside `.pi/livespec/` SHALL be allowed, SHALL get a warning that starts with `livespec guard:` appended to its tool result, and SHALL append one line `<YYYY-MM-DD> — <path> — <tool> outside a change or fix branch` to `specs/bare-work.md`, creating the file when missing, with the local date and the path relative to the project root. A line MUST NOT be appended when an entry of the same date already lists that path. A failure to read the branch, to check whether the file is tracked, or to write the log MUST NOT block the call; the warning SHALL then say the work was not logged and why. In a child session and in a project that is not initialized, nothing SHALL be logged and no warning added. Edits made through `bash` are not detected.

#### Scenario: Edit on main is logged
- **WHEN** on `main` the agent calls `edit` on the tracked file `src/app.ts` on 2026-11-22
- **THEN** the edit runs, its result carries a `livespec guard:` warning, and `specs/bare-work.md` ends with `2026-11-22 — src/app.ts — edit outside a change or fix branch`

#### Scenario: Logged once per day
- **WHEN** the agent edits `src/app.ts` twice on `main` on the same day
- **THEN** `specs/bare-work.md` has one entry for `src/app.ts` on that date

#### Scenario: Not bare work
- **WHEN** the agent writes `src/app.ts` on `fix/typo` or `livespec/rate-limit`, writes `specs/product.md` on `main`, or writes an untracked new file on `main`
- **THEN** no warning is added and `specs/bare-work.md` is unchanged

#### Scenario: Log failure allows the edit
- **WHEN** on `main` the agent edits the tracked `src/app.ts` and `specs/bare-work.md` cannot be written
- **THEN** the edit runs and its warning says the work was not logged
