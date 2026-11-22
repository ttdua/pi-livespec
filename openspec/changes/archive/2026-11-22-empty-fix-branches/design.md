## Context

`fixRange(git, integration)` in `src/fix/branch.ts` fetches `origin <integration>`, takes the merge base with HEAD, and returns `{ mergeBase, subjects }`. Three callers test `subjects.length === 0` on their own: `fixRange` in `src/tools/fix-ship.ts` (refusal 3), `buildFixCard` in `src/hooks/card-input.ts` (`empty: true`), and `fromFixRefusal` in `src/tools/change-new.ts` (no check). `Git` already exposes `mergeTree(a, b)` (`{ tree } | "conflict" | "unsupported"`, used by `src/ship/reviewed.ts`), `treeOf(commit)` and `remoteRef(name)`.

## Goals / Non-Goals

**Goals:**
- One function decides emptiness; every caller reads its result.
- Detect landed content after merge, squash or rebase merges, also after later integration commits.

**Non-Goals:**
- Detecting partially landed fixes; deleting or switching away from the fix branch; any change to the `lane` rule or facts.

## Decisions

- **D1 — Extend `fixRange` instead of adding a second call.** It returns `{ mergeBase, subjects, empty }`. Every caller already calls it right after the fetch, so the check reuses the fetched `origin/<integration>` and needs no extra fetch. A separate helper would let a caller forget it, which is the bug being fixed.
- **D2 — Emptiness test.** `empty = subjects.length === 0 || landed`. `landed` takes `tip = origin/<integration>` (`remoteRef`, present after the fetch) and runs `mergeTree(tip, "HEAD")`. A `{ tree }` equal to `treeOf(tip)` → landed. `"conflict"` → not landed (real work, or at least work the human must look at). `"unsupported"` (git < 2.38) → fall back to `treeOf("HEAD") === treeOf(tip)`, which still covers the case right after a merge. Alternatives (tree equality only, `git cherry`) were rejected in brainstorm.md. A missing tip ref or an unexpected `mergeTree` error → not landed (fail-safe: a fix is never falsely empty; the lane and tests still run). Run `landed` only when `subjects` is non-empty, so a plain empty fix does not pay for a merge-tree.
- **D3 — Message wording.** One reason phrase shared by callers: `<branch> adds nothing to origin/<integration> (no commit after the merge base, or its changes are already there)`. `fix_ship`: `there is nothing to ship: <phrase>; switch back to <integration>.`. `change_new --from-fix`: `there is nothing to move: <phrase>; switch back to <integration>.`. Card next step: `Nothing to ship on fix/<slug>: it adds nothing to the integration branch. Switch back to the integration branch.`
- **D4 — Refusal order in `change_new --from-fix`.** Checked right after the merge base succeeds and before the open pull request lookup, so an empty fix triggers no pull request lookup and no write. Like every other refusal there, it creates no issue and renames nothing.
- **D5 — Card memo.** The memo key is HEAD, integration and the local `origin/<integration>` tip; `landed` depends only on those, so the memo stays correct without change.

## Risks / Trade-offs

- [A fix whose content lands only in part looks non-empty] → acceptable: the human sees `fix_ship`/the lane and decides; never a false "empty".
- [Old git without `merge-tree --write-tree` misses a landed fix once the integration branch moved on] → documented fallback; the fix then looks shippable, as today.
- [Extra git process per card build] → only when commits exist, memoized per HEAD/tip.
