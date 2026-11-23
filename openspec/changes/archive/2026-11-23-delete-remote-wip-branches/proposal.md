## Why

After `change_resume`, the `<Branch line>--wip-<unit>` branches that `change_park` pushed stay on `origin`. Today they are removed by hand (`docs/architecture.md`, "Known gap"), because no guarded path can delete a remote branch. Their work is already merged into the change branch at that point, so the leftovers are clutter. Leaving the cleanup to a human also invites deleting the wrong branch.

## What Changes

**Resume deletes the remote wip branches**
- From: discovered-dependencies "Resume tool" says "The remote wip branches SHALL be kept."
- To: after every wip merge succeeds, and before the label is removed and the resume record is posted, `change_resume` deletes each remote wip branch the `parked` record lists. It deletes a branch only while its remote head still equals the recorded head. A branch already gone counts as done. A branch whose head moved is kept and named in the result. Any other failure refuses, names the branch and leaves the change parked, so a rerun completes the deletion.
- Reason: closes the known gap without giving up retries.
- Impact: non-breaking for users; a resumed change no longer leaves wip branches on `origin`.

**A guarded delete path**
- From: command-guards "Guarded push" allows only the refspec `HEAD:refs/heads/<branch>` and only the callers `change_ship`, `change_push`, `fix_ship` and `change_park`.
- To: the guarded push module also provides a delete of `refs/heads/<Branch line>--wip-<unit>` on `origin` with a lease on the recorded head. Its only caller is `change_resume`. The branch is rebuilt from the issue's `Branch` line and a unit id of the change issue, never taken from a tool parameter.
- Reason: deleting must stay as locked down as pushing.
- Impact: `change-resume.ts` becomes the fifth allowed importer of the guarded push module.

Out of scope: local wip branches, wip branches of changes resumed before this change, and deleting at `change_close`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities
- `discovered-dependencies`: "Resume tool" deletes the remote wip branches instead of keeping them, with lease, gone and moved-head rules.
- `command-guards`: "Guarded push" gains the guarded wip-branch delete and `change_resume` as its only caller.

## Impact

- `src/guard/push.ts`: new guarded delete function.
- `src/tools/change-resume.ts`: new deletion step, result text and details.
- `tests/guard/push-callers.test.ts`, `tests/tools/change-resume.test.ts`, `tests/e2e/initiative-flow.test.ts`: allowed importers, new scenarios, and the end-to-end check of remote branches after resume.
- `docs/architecture.md`: "Resume" paragraph, the `guardedPush` paragraph, and removal of the wip "Known gap".
- No new dependency, no forge API change, no schema or migration.
