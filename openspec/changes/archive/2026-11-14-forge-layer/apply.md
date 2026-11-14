# Apply Receipt

**Change**: `forge-layer`
**Iteration**: `1`
**Applied at**: `2026-11-14 16:20`
**Executor**: `subagent-driven-development` (implementer and code-reviewer agents; a task review after each task, fix rounds until approved, then one whole-branch review)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.forge-layer`
- **Worktree branch**: `forge-layer`
- **Feature branch**: `forge-layer` (the branch checked out before step 0; the worktree already existed on it, so no second worktree was created and step 0 only committed the change directory)
- **Base branch**: `main`

---

## Commits

- **Range**: `7283ed5..HEAD` (`7283ed5` is the scaffold commit of the change directory; HEAD is the commit that holds this receipt's parent, `378f124`; the receipt itself is committed after it)
- **Count**: `40` commits up to `378f124`, including 4 merge commits (2 lane merges and 2 merges of `forge-layer` into a lane)

---

## Tasks

- **Completed**: `21 of 21` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

Final state: `bun run test` 404 passed (15 files), `bun run typecheck` clean, `openspec validate forge-layer` valid. A manual smoke run on real GitHub and real Gitea 1.27.3 passed and was repeated after the last code change; see `smoke.md`.

---

## Contract deviations

All were raised while building, and each public one was decided by the user in the Inbox thread `forge-layer`.

- `Forge.updatePullRequest` (public): the issue #3 sketch had no `expect`; it now takes `expect: Version` and returns `WriteResult<PullRequest>`. Reason: the forge-interface spec requires fail-closed PR body writes. User decision.
- `WriteResult` (public): was `{status:"written"; issue: Issue; ...}`; now generic `WriteResult<T extends {version: Version}>` with `item: T`, used as `WriteResult<Issue>`, `WriteResult<PullRequest>` and `WriteResult<Comment>`. Reason: comment and PR edits have no issue to return. User decision (a clean typed design, no temporary workaround).
- `LabelRepo` (internal, new): `listLabels()` and `createLabel(name)` with `ensureLabels(repo, labels)`, implemented by both adapters. Reason: the public `Forge` has no label-creation method and was not widened.
- Own-marker comment edits (spec and contract): every adapter's `updateComment` re-reads the comment and refuses unless it carries a marker and the current account wrote it. New spec scenario "Edit an unmarked own comment". Reason: both adapter reviews found the write boundary unguarded; the earlier contract only tested a helper.
- GitHub `check` value (spec): body writes return `best-effort`, not `strict`. Reason: GitHub has no server-side conditional write; `strict` is only for Gitea with `content_version`. The `Unchanged` scenario in the github-adapter spec was changed to match.
- `GitHubForgeOptions.hostname` (public, additive): optional GitHub Enterprise host, passed as `--hostname` to every `gh` call; `detectForge` fills it and keeps an http(s) port but not an SSH port.
- `detectForge` deps (public, additive): optional `readFile`, `homedir`, `platform` next to `exec`, `fetch`, `env`.
- `GiteaOptions` (public, additive): `timeoutMs`, `homedir`, `platform`, `teaConfigPath`; `createExec({timeoutMs})` and `DEFAULT_GH_TIMEOUT_MS` exported from `github.ts` (not in the barrel). `ExecFn` and `ExecResult` types are now exported from the barrel.
- Error mapping (design): 401 and 403 map to `auth` on both forges, except a GitHub 403 that mentions a rate limit, which is `http`. A `gh` failure is `unreachable` only when it looks like a network or spawn error.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | sequential | `31d733e..820a020` | APPROVED (one minor fixed) | n/a (on `forge-layer`) |
| 2 | sequential | `820a020..ab0d93b` | APPROVED after 1 fix round | n/a |
| 3 | sequential | `ab0d93b..728d5fe` | APPROVED after 1 fix round | n/a |
| 4 | `forge-layer--task-4` | `c25b68f..ebdaff2` | APPROVED after 3 fix rounds | `cb52120` |
| 5 | `forge-layer--task-5` | `c25b68f..96b542a` | APPROVED after 4 fix rounds (the last two findings were closed on `forge-layer` in `67e8d97` and `7084690`) | `f1f023e` |
| 6 | sequential | `a0e51e0` base `c25b68f` | APPROVED after 2 fix rounds | n/a |
| 7 | sequential | `67e8d97..acd9840` | APPROVED after 1 fix round (`02ac487`, `7084690`, `acd9840`) | n/a |
| 8 | sequential | docs and smoke | whole-branch review APPROVED | n/a |

Whole-branch review of `7283ed5..30f863f`: APPROVED, with minor findings. All were then fixed in `80a93d1`, `d5a3a0a` and `b051207`, except two left as documented limits below. Tasks 4 and 5 ran in parallel lanes; the lane worktrees and branches are removed.

Tasks 1 and 2 had no separate approval re-run; Task 3's review is covered by the strengthened-suite commit `728d5fe`. The rounds above are listed from the review logs of this session.

---

## Known limits kept

- Gitea comment edits are last-write-wins and GitHub body writes have a small race window between the re-read and the PATCH (ADR 0007; reported as `best-effort`).
- GitHub Enterprise `--hostname` is tested only with the fake `gh`.
- `GITEA_TOKEN` is sent to the host of the detected remote, including plain http remotes (recorded in `design.md` Risks).
- Cache paths join `owner/repo` from the remote directly; the remote is the user's own, so this was left as is.

---

## Next step

Run `/opsx-verify`.
