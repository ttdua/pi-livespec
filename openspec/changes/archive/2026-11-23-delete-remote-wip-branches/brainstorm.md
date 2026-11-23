## Design Summary

Closes issue #45 (split out of #42). Today the `<Branch line>--wip-<unit>` branches that `change_park` pushes stay on `origin` after `change_resume`, and a human deletes them by hand (`docs/architecture.md`, "Known gap"). After this change, `change_resume` deletes them itself once their work is merged into the change branch.

This changes two specified requirements:

- discovered-dependencies "Resume tool": "The remote wip branches SHALL be kept." becomes "the remote wip branches of the `parked` record SHALL be deleted", with the safety rules below.
- command-guards "Guarded push": today the only refspec is `HEAD:refs/heads/<branch>` and the only callers are `change_ship`, `change_push`, `fix_ship` and `change_park`. This change adds a guarded delete path and makes `change_resume` its only caller.

**Intent.** A parked and resumed change should leave no clutter on the forge, and the agent should still never be able to delete an arbitrary remote branch.

**Goals**
- `change_resume` deletes every remote wip branch that the `parked` record lists, after every wip merge has succeeded and before the label is removed and the resume record is posted.
- The branch names and expected heads come only from the `parked` record, which is built from the issue's `Branch` line and unit ids. No tool parameter, command or environment variable can choose the remote, the branch or the head.
- Safe and idempotent on rerun:
  - a branch that is already gone is not an error;
  - a branch whose remote head differs from the head in the `parked` record is kept and named in the result;
  - deleting one branch never deletes a different one.
- If a deletion fails (network, permissions), the tool refuses and the change stays parked. Rerunning `change_resume` skips the merges already done and the branches already gone, then completes the resume.

**Non-goals**
- Deleting local wip branches (`git branch`). They are not on the forge; whether to clean them up is a separate decision.
- Cleaning up wip branches of changes that were resumed before this change. These are still deleted by hand.
- Deleting branches at `change_close`, or deleting change or fix branches.

**Anti-goals**
- Any delete path the agent can steer: a free-form refspec, or a branch name from a tool argument.
- Losing work: a wip branch that someone pushed to after the park must never be deleted.

## Alternatives Considered

### Alternative A: Delete in `change_resume` after the merges, before the resume record (chosen)
- **Approach**: a new step between "merge each wip branch" and "post the resume record". A failure refuses and leaves the change parked.
- **Pros**: retries come for free, because every step already skips what is done. The branches exist exactly while the change is parked.
- **Cons**: a forge problem during deletion blocks the resume until a rerun succeeds.
- **Why chosen**: the only option where a failed deletion can always be retried through a livespec tool.

### Alternative B: Delete after the resume record, failures only reported
- **Approach**: same tool, but the deletion runs last and never refuses.
- **Pros**: the resume is never blocked.
- **Cons**: once the change is no longer parked, `change_resume` refuses, so there is no way to retry and leftovers go back to manual deletion.
- **Why not chosen**: it brings back the known gap whenever a deletion fails.

### Alternative C: Delete at `change_close`
- **Approach**: `change_close` deletes the wip branches listed by the latest `parked` record.
- **Pros**: the work is certainly in a merged pull request, and the close already has skip-when-done retries.
- **Cons**: branches stay on the remote through build, review and ship. It also needs an extra decision about abandoned changes.
- **Why not chosen**: the merge into the change branch is already enough evidence; waiting adds clutter without adding safety.

## Agreed Approach

Alternative A, chosen by the user. `change_resume` gets one new step 3 between the wip merges and the label removal and resume record. For each unit of the `parked` record that has a branch and a head, it deletes that remote branch through a guarded delete path. The deletion only goes through when the remote head still equals the recorded head. A branch that is gone counts as done. A branch with a different head is kept and named in the tool result, and it does not block the resume. Any other failure refuses with the branch named, and the change stays parked.

## Key Decisions

- Deletion is part of `change_resume`, not `change_close` (user).
- Inputs come only from the `parked` record (issue #45).
- Already gone means done. A moved head means kept and reported, not refused (issue #45).
- A failed deletion refuses and keeps the change parked, so a rerun finishes the work (user, via Alternative A).
- Local wip branches are out of scope (my call: the issue covers only `origin`, and local branches do not clutter the forge).
- `change_resume` becomes the fifth caller of the guarded push module. The architecture "Known gap" note on wip branches is removed (my call: this follows from the change).

## Open Questions

None.
