# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `durable-docs-audit`
**Iteration**: `1`
**Applied at**: `2026-11-24T17:20Z`
**Executor**: `subagent-driven-development` (implementer seat `superspec.implementer`, review seat `superspec.task-reviewer`, through `subagent`; thinking from task Difficulty, no model override)

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.durable-docs-audit`
- **Worktree branch**: `durable-docs-audit`
- **Feature branch**: `ls-10`
- **Base branch**: `main`

---

## Commits

- **Range**: `ab40e1b..992da49` (plus this receipt commit)
- **Count**: `35`
- **Fresh verification at 992da49**: `bun run typecheck` exit 0; `bunx vitest run` 240 files, 3561 tests passed; `openspec validate durable-docs-audit` valid.

---

## Tasks

- **Completed**: `30 of 30` checkboxes in tasks.md flipped to `- [x]`
- **Remaining**: none

---

## Contract deviations

All internal (no `public` contract changed); each entry is recorded in plan.md "Contracts" with its reason.

- `addedSpecLines`: takes `frontEnds: Map<string, number>` and returns `{ file, line, no }` — the diff alone cannot show where front matter ends (Task 1 fix 1); `no` gives line adjacency for sentence boundaries (Task 1 fix 2).
- `frontMatterEnd`: new helper `(content: string) => number` for the above.
- `CheckGit`: gained `showFile`/`listTree` (planned) and `diffNameStatus` (Task 2 added `diffNames`; the final fix wave replaced it with the rename-aware `diffNameStatus` so behavior facts and ship use the same path set).
- `Git.diffNames`, `Git.changedPaths`, `Git.commitPaths`: NUL-delimited (`-z`) output so quoted Unicode/space names match globs (Task 8 fix 1, final fix wave).
- `classify`: optional `config` (the pack's `decisions.drift-severity`), default `{ mode: "rule" }` (Task 6).
- `deliverReport`: new unit for the D10 destination rule; a failed post prints with the error (Task 7).
- `AuditDeps`: gained `severity`; dropped unused `root`/`specs` (Task 7; final fix wave).
- `readAuditState`/`writeAuditState`/`updateAuditState`: locked read → transform → write under `<git common dir>/livespec/audit`, unique temp names (Task 8 fix 1).
- `scanCommits`: narrowed `Pick` deps, reads `firstParentCommits(tip, { after: cursor })`, returns `ScanResult` with `error` (Task 8, fix 1).
- `pendingReasons`, `suggestAtStart`, `initiativeAndSave`, `auditAndSave`, `capabilityPaths`, `cardAudit`, `Session.showAudit`: new helpers so `session.ts`/`subcommands.ts` call one function each and the audit never calls `session.refresh()` (Task 8, fix 1); scans merge only newly found suggestions and both paths revalidate ancestry against the latest state under the lock (Task 8 fix 2, final fix wave).
- `registerPacketSourceOnce`: internal idempotent registration for the doc readers; `registerPacketSource` keeps append semantics (Task 4 fix 1).

Spec clarification during apply (controller ruling, committed in `62fc2fd`): durable-doc-checks "Behavior change question at the gate" and phase-gates "Gate tool" exception apply only when the target phase lists the `behavior-change` check; new scenario "Flow without the check".

---

## Lanes

All tasks ran sequentially in the change worktree (ruling: order 1, 2, 3, 4, 6, 5, 7, 8, 9; Task 5 is blocked by Task 6).

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| Task 1 | sequential | `ab40e1b..48e1ffe` | clean after 2 fix rounds | — |
| Task 2 | sequential | `c2237cc..62fc2fd` | clean after 1 fix round, 1 ruling | — |
| Task 3 | sequential | `f7ce00a..43fb96c` | clean after 1 fix round | — |
| Task 4 | sequential | `8047523..f1b02d2` | clean after 1 fix round | — |
| Task 6 | sequential | `631880d..babd317` | clean after 1 fix round | — |
| Task 5 | sequential | `56c9418..0973085` | clean | — |
| Task 7 | sequential | `90fae0a..9989282` | clean after 2 fix rounds | — |
| Task 8 | sequential | `583612d..394b844` | clean after 2 fix rounds, 1 ruling | — |
| Task 9 | sequential | `301bd14..2c2a021` | clean after 1 fix round | — |
| Final whole-branch review | sequential | `ab40e1b..992da49` | clean after one fix wave (`d2d932f..992da49`), 1 ruling | — |

Rulings (controller, with cost if wrong):
1. Sequential execution order — cost: longer wall clock only.
2. Behavior question only where the phase lists the check (spec clarified) — cost: custom flows that drop the check never get the question.
3. Session start keeps awaiting the suggestion scan (capped at 50 commits) — cost: slower session start on a slow forge.
4. Glossary/decision/constraints packet readers stay `untrusted: false` (repository content, like existing `spec:<cap>` sources; the living "Untrusted wrapping" requirement covers human forge text) — cost: a malicious glossary or decision file in the repo can address implementer/reviewer children directly.

---

## Next step

Run `/opsx-verify`.
