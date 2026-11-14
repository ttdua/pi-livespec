# Manual smoke run

Date: 2026-11-14. Run from the `forge-layer` worktree with a throwaway script outside the repository (not kept). Each run created an issue and a pull request, edited bodies with the current and a stale `version`, wrote and edited a marked comment, added a label, searched, closed the issue and read checks.

## GitHub (real)

- Repository: `ttdua/superspecplan` (private), account `ttdua`, through `gh` 2.103.3.
- Result: all steps behaved as the specs require.

| Step | Result |
|---|---|
| `whoami` | `ttdua` |
| `createIssue` with `livespec` and `livespec:phase/define` | created; missing labels were created on demand |
| Body edit with the current version | `written`, `check: best-effort` |
| Body edit with a stale version | `conflict`, `changed: body`; forge body unchanged |
| Marked comment write, `readMarkedComments` | 1 own comment, 0 warnings |
| Own marked comment edit | `written` |
| `addLabels` with `livespec:parked` | applied |
| `searchIssues` by label | found the issue, no pull requests in the result |
| `closeIssue` | `closed` |
| `createPullRequest`, `findOpenPullRequest`, `getPullRequestFiles` | PR number, head lookup and file list correct |
| PR body edit current / stale | `written` (`best-effort`) / `conflict` |
| `getChecks` | `pending`, 4 checks |

Cleanup: PR closed and its branch deleted, the issue deleted, the three labels the run created removed. The repository is back to `main` only.

## Gitea (real)

- Server: `https://gitea.ltt.onl`, Gitea 1.27.3 (`/api/v1/version`), account `naicoi`, token from `ORCA_GITEA_TOKEN` passed as `GITEA_TOKEN`.
- Repository: scratch repo `naicoi/livespec-smoke` created for the run and deleted afterwards (DELETE returned 204, then 404).

| Step | Result |
|---|---|
| `whoami` | `naicoi` |
| `createIssue` | created with `content_version` (`cv:0`) and both labels |
| Body edit with the current version | `written`, `check: strict` |
| Body edit with a stale version | `conflict`, `changed: body`; forge body unchanged |
| Marked comment write, `readMarkedComments` | 1 own comment, 0 warnings |
| Own marked comment edit | `written` |
| `addLabels` | applied |
| `searchIssues` by label | found the issues |
| `closeIssue` | `closed` |
| `createPullRequest`, `findOpenPullRequest`, `getPullRequestFiles` | correct |
| PR body edit current / stale | `written` (`strict`) / `conflict` |
| `getChecks` | `none` (no statuses in the scratch repo) |

### Older-server fallback on the real server

The real server sends `content_version`, so the fallback path was exercised by hiding the field from the adapter (response field removed, request field dropped) while still talking to the real server.

| Step | Result |
|---|---|
| Version scheme | `rc:` prefix (re-read check) |
| Body edit with the current version | `written`, `check: best-effort` |
| Body edit with a stale version | `conflict`, `changed: body` |

### Re-check after the response-field guards (second scratch repo, deleted afterwards)

| Step | Result |
|---|---|
| Raw combined status of an empty commit | `state: pending`, `statuses: null`, `total_count: 0` |
| `getChecks` on it | `none`, no checks (the `null` is accepted) |
| `getChecks` after posting a `failure` status | `failure`, one check `ci/a` |
| `getPermission` for the token's own account | `admin` |

## Findings

- No adapter defect was found. The one failure during the run was in the throwaway script (it passed an `Issue` where `readMarkedComments` takes the issue number); the script was fixed and the run repeated from a clean state.
- Gitea releases that carry `content_version`: the field is present on 1.27.3 and was present on 28.3.0 in probe (g). Not used as a gate (see `design.md`).

## Not covered

- GitHub Enterprise (`--hostname`) was only tested against the fake `gh`.
- GitHub token scopes beyond what `gh` already had were not varied.
