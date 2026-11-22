## Design Summary

Issue #37, follow-up to `small-fix-lane` (#33 / PR #36). The small-fix lane decides "is there anything on this fix branch?" only by counting commits after the merge base with `origin/<integration>`. Two cases slip through:

1. `change_new <name> --from-fix` on a fix branch with no commit after the merge base succeeds: it creates a `define` change issue whose Proposal is only `Moved from fix/<slug>:` and renames the branch. The card and `fix_ship` already call such a branch "nothing to ship"; `--from-fix` is the odd one out.
2. After the fix's pull request is squash- or rebase-merged (this repo squash-merges), the fix commit is not an ancestor of `origin/<integration>`, so the branch still counts as one commit ahead. The card says `fix_ship`, and `fix_ship` pushes and opens a new pull request with no content difference. `--from-fix` would move already-landed work into a new change.

Goal: one shared notion of an *empty* fix, used by the fix card, `fix_ship` and `change_new --from-fix`. A fix is empty when it has no commit after the merge base, or when merging HEAD into `origin/<integration>` would change nothing (its content has already landed). Then:

- fix card: next step says there is nothing to ship (not `fix_ship`, not `change_new --from-fix`).
- `fix_ship`: refuses with "nothing to ship"; no push, no pull request.
- `change_new --from-fix`: refuses with "nothing to move"; no issue is created and no branch is renamed.

Non-goals: no automatic deletion of the fix branch or switch back to the integration branch; no change to the `lane` rule, its facts, or the other refusals and their order; no detection of partially-landed fixes (some content merged, some not) — those stay non-empty.

Anti-goal: a real fix that conflicts with or differs from the integration branch must never be reported as empty; a false "nothing to ship" would hide work.

Spec impact: this alters specified requirements of `small-fix-lane`:
- "Fix ship tool" refusal 3 and scenario "Nothing to ship" (today defined by commit count only; its "after its pull request was merged" example holds only for merge commits).
- "Fix card" (empty next step defined by commit count only).
- "Move a fix into a change" (lists refusals; has none for an empty fix).

## Alternatives Considered

### Alternative A: Tree equality with the integration tip (as proposed in the issue)
- **Approach**: empty when no commit follows the merge base or `git diff --quiet origin/<integration> HEAD`.
- **Pros**: trivial; matches the issue text.
- **Cons**: only works while the integration branch has no later commit. Once any other pull request lands after the squash merge, the trees differ and the merged fix looks shippable again — the common case in a squash-merging repo.
- **Why not chosen**: misses the case the issue is about as soon as the integration branch moves on.

### Alternative B: Patch-id comparison (`git cherry`)
- **Approach**: empty when every fix commit has an equivalent patch upstream.
- **Pros**: handles rebase merges and later integration commits.
- **Cons**: a squash of several fix commits produces one patch that matches none of them.
- **Why not chosen**: fails squash merges of multi-commit fixes.

### Alternative C: Merge would change nothing
- **Approach**: empty when no commit follows the merge base, or when a virtual merge of HEAD into `origin/<integration>` yields exactly the integration tip's tree. A conflicting merge means not empty.
- **Pros**: handles merge, squash and rebase merges, single or multi-commit, even after the integration branch moved on; needs no fetch beyond the one the lane already does; never touches the work tree.
- **Cons**: slightly more git work; needs a fallback on old git without a write-tree merge.
- **Why not chosen**: chosen.

## Agreed Approach

Alternative C, approved by the user. It is the only option that keeps "nothing to ship" true after a squash merge in a repository whose integration branch keeps moving, which is how this repo works. Where the virtual merge is unavailable (old git), fall back to Alternative A's tree equality, which still covers the immediate post-merge case.

## Key Decisions

- One shared emptiness check for all three call sites; their messages differ ("nothing to ship" vs "nothing to move").
- "Empty" = no commit after the merge base OR merging the fix into `origin/<integration>` changes nothing.
- A merge conflict means "not empty": the existing flow (lane facts, tests, pull request) handles it.
- Without virtual-merge support, fall back to tree equality with `origin/<integration>`.
- `change_new --from-fix` gains the refusal "nothing to move", checked with the merge-base refusal, before the open pull request check, creating no issue and renaming nothing.
- Spec text is updated in `small-fix-lane` for "Fix ship tool", "Fix card" and "Move a fix into a change", with new scenarios for a squash-merged fix and "Nothing to move".

## Open Questions

None.
