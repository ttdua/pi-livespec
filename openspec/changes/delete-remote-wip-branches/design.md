## Context

`change_resume` (`src/tools/change-resume.ts`) runs these steps today: `syncChange`, then `mergeWips` (each wip head of the `parked` record, in unit order, skipping heads already in HEAD), then removing `livespec:parked`, then posting the resume `parked` record. Each step skips what is already done, so a rerun finishes a partial resume. The `parked` record stores `{ unit, branch, head }` for every unit with work (`ParkedUnit`). `src/guard/push.ts` exposes only `guardedPush(exec, root, remote, refspec)`, and `tests/guard/push-callers.test.ts` locks its importers to `change-ship.ts`, `change-push.ts`, `fix-ship.ts` and `change-park.ts`.

## Goals / Non-Goals

**Goals:**
- Delete each remote wip branch of the `parked` record during `change_resume`, safely and idempotently.
- Keep the guarded module the only place that runs `git push`, with no agent-controlled inputs.

**Non-Goals:**
- Local wip branches, older leftovers, and cleanup at `change_close` (see brainstorm.md).

## Decisions

**D1. Delete with a lease, not by comparing then deleting.** Add `guardedDeleteWip(exec, root, branch, head)` to `src/guard/push.ts`. It runs `git ls-remote --exit-code -- origin refs/heads/<branch>`, then:
- exit 2 (no such ref) returns `gone`;
- the sha of the line whose ref name is exactly `refs/heads/<branch>` (`ls-remote` matches by trailing path components, so a decoy such as `refs/heads/pre/refs/heads/<branch>` is also listed and is ignored; no exact line counts as gone) differs from `head`: `moved`;
- otherwise it runs `git push --force-with-lease=refs/heads/<branch>:<head> -- origin :refs/heads/<branch>` and returns `deleted`.

When the push fails, it repeats `ls-remote` once to classify the failure:
- the ref is now gone: `gone`;
- it now has another sha: `moved`;
- it still holds `head`: throw `GitError`.

The remote is fixed to `origin` inside the function, so callers cannot pass it. The lease closes the race between the check and the delete: a branch pushed to in that window is rejected as stale and reported as `moved`, never deleted. Alternative: a plain `:refs/heads/<branch>` after the check. Rejected because of that race. Verified locally: a delete with a stale lease exits 1 with "stale info" and leaves the ref in place.

**D2. Inputs are rebuilt, not trusted.** `change_resume` deletes only units of the `parked` record where all of these hold:
- the unit is a unit id of the change issue;
- the record's `branch` equals `wipBranch(<Branch line>, unit)`;
- the record's `head` is a full sha (40 or 64 hex digits, so SHA-256 repositories work).

Any other entry is not passed to the delete and is named in the result as kept. The checks apply only to the delete: `mergeWips` keeps its current behaviour of merging every record entry with a branch and a head. Validating the merges too would change existing behaviour and is out of scope. `guardedDeleteWip` itself rejects a branch name that does not contain `--wip-` or starts with `-`, as defence in depth. Alternative: trust the record's `branch` field. Rejected because the record lives on the forge, and the guard's contract is "refspec from the Branch line and a unit id".

**D3. Placement and retry.** The new step runs after `mergeWips` returns `merged` and before the label removal. On a thrown `GitError` the tool refuses with the branch named and the cause wrapped in `untrusted(...)`, and states that the change stays parked and that the branches deleted so far are gone. A rerun skips the merges already done (existing behaviour) and the branches already gone (D1), then completes. A branch reported `moved` does not refuse: its recorded work is already merged, and the newer commits belong to someone else.

**D4. Result shape.** `ChangeResumeDetails` gains `deleted?: string[]` and `kept?: string[]` (moved, or skipped by D2). The text adds "Deleted remote <branches>." and "Kept on origin: <branch> (<reason>), …." with a reason per branch: "head moved since the park" or "not a wip branch of this change". Branch names are wrapped in `untrusted(...)`. This is an internal tool result, not a public contract.

**D5. Caller lock.** `tests/guard/push-callers.test.ts` adds `change-resume.ts` to the allowed set and drops the `not.toContain("change-resume.ts")` assertion. The module header comment and the spec name `change_resume` as the only caller of the delete.

## Risks / Trade-offs

- [A forge outage during deletion blocks the resume] → the refusal says to rerun once the forge is reachable; the merges are already in HEAD and are not repeated.
- [A human pushed to a wip branch after the park] → the lease and the head check keep it, and the result names it for a human to handle.
- [Wip branches from resumes before this change] → out of scope; still removed by hand, as documented.
- [`ls-remote` exit 2 also returned for other reasons] → git documents exit 2 for `--exit-code` only when no matching ref is found; any other failure exits 128 and is thrown.

## Migration Plan

None: no persisted format changes. Parked changes resumed after the upgrade get their branches deleted; earlier resumes keep theirs.

## Open Questions

None.
