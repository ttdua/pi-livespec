## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Guarded push
The package SHALL provide `guardedPush` as the only code path that runs `git push`. It MUST NOT be reachable from any tool parameter, command or environment variable that the agent controls: the remote SHALL always be `origin` and the refspec SHALL always be `HEAD:refs/heads/<branch>`, where `<branch>` is the change issue's `Branch` line for `change_ship` and `change_push`, and the checked-out fix branch for `fix_ship`. Only `change_ship`, `change_push` and `fix_ship` SHALL call it, and only after their refusal checks pass (see ship-phase and small-fix-lane).

#### Scenario: No tool calls the push path
- **WHEN** the sources under `src/tools/` are scanned
- **THEN** no tool other than `change-ship.ts`, `change-push.ts` and `fix-ship.ts` imports the guarded push module

#### Scenario: Refspec from the issue
- **WHEN** `change_ship` pushes for a change whose `Branch` line is `livespec/rate-limit`
- **THEN** `guardedPush` runs `git push -- origin HEAD:refs/heads/livespec/rate-limit` and no tool parameter changes the remote or the refspec

#### Scenario: Refspec from the fix branch
- **WHEN** `fix_ship` pushes on the checked-out branch `fix/typo`
- **THEN** `guardedPush` runs `git push -- origin HEAD:refs/heads/fix/typo`
