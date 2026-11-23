## 1. Guarded wip-branch delete

Blocked by: none

- [x] 1.1 `src/guard/push.ts`: add `guardedDeleteWip(exec, root, branch, head)` returning `"deleted" | "gone" | "moved"`. The remote is fixed to `origin`. It throws `GitError` without pushing when the branch lacks `--wip-` or starts with `-`. It reads the ref with `ls-remote --exit-code` (exit 2 means `gone`) and deletes with `--force-with-lease=refs/heads/<branch>:<head>`; on a failed push it reads the ref again to tell `gone`, `moved` and a real failure apart (design D1). Update the header comment.
- [x] 1.2 Tests in `tests/guard/push-callers.test.ts` against a real bare `origin`: deleted at the recorded head, gone, moved, a lease that goes stale between read and delete (simulated by a different sha), a non-wip name refused with no `push` call, and a failure (unreachable remote) thrown as `GitError` (command-guards "Delete of a wip branch", "Delete refuses a non-wip branch").

## 2. Resume deletes remote wip branches

Blocked by: 1

- [x] 2.1 `src/tools/change-resume.ts`: after `mergeWips` succeeds, add the delete step in unit order. Only units of the change issue whose record branch equals `wipBranch(<Branch line>, unit)` and whose head is a full sha (40 or 64 hex digits) are deleted; any other unit is kept (design D2). A `moved` result is kept, a thrown `GitError` refuses naming the branch (cause wrapped in `untrusted`) and leaves the change parked (D3). The step runs before the label removal and the resume record.
- [x] 2.2 `ChangeResumeDetails` gains `deleted` and `kept`; the result text names the deleted and kept branches (D4). Update the module header comment and the tool description ("Never pushes" no longer holds).
- [x] 2.3 Allow `change-resume.ts` as an importer in "No tool calls the push path" (`tests/guard/push-callers.test.ts`, D5).
- [x] 2.4 Tests in `tests/tools/change-resume.test.ts`: update "Resume with two lanes keeps all work" (the branches are now deleted) and the expected `details` of existing tests; add "Remote wip branches deleted after resume", "Wip branch already gone", "Wip branch moved since the park", and "Delete fails and rerun completes" (discovered-dependencies "Resume tool").
- [x] 2.5 Extend `tests/e2e/initiative-flow.test.ts` so that after `change_resume` the wip branches are absent from `origin`.

## 3. Docs

Blocked by: 2

- [ ] 3.1 `docs/architecture.md`: in "Resume", describe the delete step and its gone, moved and failure rules; in the `guardedPush` paragraph, describe the delete and its single caller; remove the wip-branch "Known gap".
