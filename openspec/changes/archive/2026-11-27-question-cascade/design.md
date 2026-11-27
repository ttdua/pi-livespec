## Context

Today the requirement cascade lives in `src/interaction/complete-question.ts`: `applyQuestion` reads `answer.changesRequirement` (set by the in-session flow in `in-session.ts`, the dialog in `dialog/state.ts`/`dialog/result.ts`, or the forge `--changes` flag in `commands.ts`/`forge-match.ts`), unticks the done covering units in the same body write as the answer line, posts a `stale` comment with id `Q<n>`, and moves the change back to define. `change_sync` (`src/initiatives/sync.ts`) has its own private `changedRequirements`, comparing `requirementContent` (parsed text and scenarios, no line numbers) of `specs/<capability>/spec.md` between two revisions via `git.showFile`.

The lock is derived in `src/engine/locks.ts` from the latest approved, non-superseded plan `gate` comment, which also carries `head_sha` (the HEAD the request or self gate saw). `stale` comments are read there for `staleUnits` and gate invalidation, and in `src/engine/iterations.ts` for `change_iterations` (`after_plan: true`). Extra keys in a `stale` comment's data are ignored by both.

The brainstorm fixes the behaviour; this document fixes how.

## Goals / Non-Goals

**Goals:**
- One requirement-diff function shared by `change_sync` and the spec-diff cascade.
- A spec-diff cascade that is idempotent per requirement content and completes a partial run.
- Remove every trace of the requirement step from the question path, with old records still readable.

**Non-Goals:**
- A durable baseline outside git history (proposed on #59, LS-12 ledger).
- Detecting uncommitted spec edits: the detector compares committed HEAD only.

## Decisions

### D1. One detector: digests at a revision, compared as maps (`src/engine/requirement-diff.ts`)
- `requirementContent(r)` moves from `sync.ts`. It collapses every run of whitespace in the text and in each GIVEN/WHEN/THEN line to one space before serialising, so re-wrapped or re-indented text is not a change; the parser already drops line positions.
- `requirementDigests(git, rev, scope)` returns `{ id: sha256(content) }` for every requirement of `specs/<capability>/spec.md` at `rev`, reading the files with `git.showFile`.
- `changedIds(before, after)` returns the ids whose digest differs, including ids present on one side only, sorted. A missing file contributes nothing to a map. `parseSpec` tolerates malformed Markdown, but malformed YAML frontmatter throws; the run then records the error and writes nothing, as `change_sync` fails today, and resumes once the spec is fixed.
- Duplicate ids: when two requirements of one capability normalize to the same id, `requirementDigests` throws an error naming the capability and the id instead of keeping the last one; the run fails the same way (records the error, writes nothing).
- `change_sync` uses the pair: `changedIds(await requirementDigests(git, oldBase, caps), await requirementDigests(git, base, caps))`. It keeps its `oldBase === base` short-circuit, and its behaviour changes only by the whitespace collapse. This is `changedRequirements` refactored into the shared pair, as the issue asks.
- `src/fix/lane-facts.ts` keeps its own name-level `requirementsAt`, because it compares structure, not content.
- Why maps of digests and not content pairs: the baseline is a digest record (D3), so both callers compare the same shape. Git is only one way to produce a map.
- `Covers` matching: both callers trim the entry and collapse inner whitespace runs before matching ids, through one shared `coversId(entry)`; `change_sync` thereby also matches an entry with doubled inner spaces, a harmless widening.
- Known parser limit, unchanged: scenario lines other than GIVEN/WHEN/THEN (for example `**AND**`) are not part of content, as for `change_sync` today.

### D2. Spec-diff cascade, split by responsibility
`src/interaction/spec-cascade.ts` holds the effect side and `src/interaction/spec-cascade-plan.ts` the pure planner.
- `readCascadeInput(target)` does the I/O. It reads the issue and the own marked comments fresh, then `deriveLocks` (with `LockState.baseline`), the phase, and three digest maps:
  - `heads`: `requirementDigests(git, "HEAD", scope ∪ acknowledged capabilities)`;
  - `reference`: the same at the integration reference (D3), or `undefined`;
  - `legacy`: only for a gate without a record, computed at its `head_sha` when `hasCommit` (D6).
- `planSpecCascade(input)` is pure and dispatches to three sub-planners; the first match wins: `planLegacyMissing`, `planCompletion`, `planNewCascade`.
- `applyCascade(target, plan)` runs `postStale`, then `untickUnits`, then `moveBack`, each skipped when already applied.
- `runSpecCascade(session)` composes them and adds the target guard, single-flight, error recording, comments-cache invalidation and a refresh after a write.
- Branch guard and pinned HEAD: the run reads the git branch and the HEAD sha once at its start. Before computing digests or writing, `readCascadeInput` checks that this branch equals the `Branch` header of the issue body it just read; otherwise the run writes nothing and returns false, recording nothing (a switched checkout is not an error). Every digest at HEAD and the merge-base use the pinned sha, so a commit landing mid-run is not mixed in.

### D3. Baseline, acknowledged digests, and the integration exclusion
- Scope: `requirementScope(change)` is the declared capabilities (the existing `declaredCapabilities`, moved to `src/core/change.ts` and reused by `engine/checks.ts` and `subagents/source-kit.ts`) plus the capability of every unit `Covers` entry, trimmed.
- Recording point: `buildRequest` (`spec-gate.ts`) computes `requirements` and `requirement_scope` for `target === "plan"` at `state.git.head`, the sha that `prepareRequest` binds as `head_sha`, and `gateRequest` stores them in the `GateSnapshot`. Plan gates are bound to HEAD and to the issue body (`headBoundReason`, `gate_digest`); `requirement_scope` is computed from `parseChange` of the same issue body that `prepareRequest` binds as `gate_digest`, not from the refreshed `state.change`, so the digests and the scope always match what is approved.
- Record parsing: `gateData` accepts `requirements` only together with a valid string-array `requirement_scope`, and vice versa; a half or malformed record is no record, and the gate takes the legacy path (D6). `applyGate` copies them from the snapshot into the plan `gate` comment; for a self gate, `passSelf` computes them at the same `state.git.head` and passes them to `selfGateComment`. The completing machine never reads that commit.
- Baseline: `LockState.baseline = { at, commentId, headSha?, requirements?, scope? }`, taken from the gate `lockOf` uses. It is not read from `GateResult`, because a cascade `stale` listing `plan` drops `gates.plan` while the lock stays.
- Acknowledged map: start from the baseline record, then overlay, in comment order, the `requirements` of every spec-cascade `stale` after the baseline gate.
  - An overlaid `REMOVED_DIGEST` deletes the id from the map, so an acknowledged removal is not seen again while the id stays absent; re-adding it cascades.
  - Changed ids are `changedIds(acknowledged, heads)`, with `heads` computed over `scope`. Acknowledged ids come from the baseline or from earlier cascades, both within `scope`, so no further restriction is needed.
  - A revert to an earlier text is a change: from baseline A, edits to B, back to A and to B again cascade three times, each with a distinct id.
- Exclusion: an id is excluded when no spec-cascade comment after the baseline names it, `reference[id] === heads[id]`, and `reference[id] !== baseline[id]`. That means the integration branch changed it after the lock and HEAD took that content.
  - Edits from `change_sync`, a hand merge or the forge's update button never cascade.
  - A revert of the change's own edit still does, because an acknowledged id is never excluded.
  - An id absent at the integration reference is never excluded, so a removal always cascades, including one merged from the integration branch. Why: a missed cascade leaves units ticked against a removed requirement, while a spurious one costs one define round.
- Integration reference: `git merge-base <pinned HEAD> origin/<integration branch>` (D2).
  - Fetch first with a best-effort `git.fetch("origin", branch)` under the git runner's existing timeout; a failure is ignored and the local ref is used.
  - `integrationBranch(project, git)` resolves the branch; skip this step when `config.project` is null.
  - `git.remoteRef` checks that the ref exists before `mergeBase`.
  - The reference digests are needed only when `changedIds` is non-empty, so the fetch and merge-base run only then; an unchanged spec costs no network call.
  - When the branch is unknown or the merge-base fails, use the recorded `Base` when `hasCommit(Base)`; otherwise there is no exclusion.
- Why merge-base and not `Base`: only `change_sync` moves `Base`, and only for initiative changes. With many changes in flight, a plain change is updated from `main` by hand or by the forge.

### D4. The cascade record
- A spec-cascade `stale` comment has an id with prefix `spec.` (`isSpecCascade`). Its data is `reason`, `phases`, `units`, `after_plan` and `requirements: { id: digest at HEAD, or "removed" }`.
- Id: `spec.<12 hex of sha256 over the baseline commentId, the count of spec-cascade comments after the baseline, and the sorted "id=digest" lines>`. Every step has a unique id, so `postOnce` never swallows a legitimate new cascade, and a rerun of the same step produces the same id.
- `units`: every unit whose trimmed `Covers` names a changed id, done or not, matching today's stale semantics. `untick` is the done subset.
- `phases`: `define` and every later phase.
- `after_plan`: `needsMoveBack(pack, phase)`; a lock always exists at this point.
- `reason`: `requirements changed since the plan lock: <ids joined by ", ">`.
- Written with `writeMarked("stale", …)`, because `staleComment` hard-codes `after_plan: false`.

### D5. Completion, one run, and concurrency
Write order is the `stale` comment, then one versioned untick body write, then `advancePhase`, as `change_sync` does.
- `planCompletion` looks at the spec-cascade and legacy-baseline comments after the baseline gate:
  - `untick`: the units they name that are still in `lock.staleUnits` and still done;
  - `moveBack`: true when `needsMoveBack` holds, such a comment listing `define` is newer than the latest valid define approval (`validApproval`), and the pack's define phase has a human or self gate. A `gate: none` define advances on its own, so moving back would flap.
  - A locked change in `build` with no define gate and no such comment is never moved.
  - Completion writes no new comment.
- One run applies completion, then re-reads and re-plans once. A partial cascade and a new edit are both handled in the same trigger.
- Concurrency in one session: `runSpecCascade` is single-flight through `session.cascadeInFlight`, like `pollApprovals`. Across sessions or machines a race may post two comments; this is the same known gap as `pollApprovals` and is recorded in Risks.

### D6. Locks without a record, and the `unit_finish` phase rule (user decisions)
- A plan gate approved before this release has no `requirements`. Its baseline is `legacy = requirementDigests(git, head_sha, scope)` while `hasCommit(head_sha)`, which includes a commit rebased away but still in the object store. This migration path disappears once such changes are closed.
- When that commit is also gone, `planLegacyMissing` plans a `stale` comment:
  - id `baseline.<sha12>`, `phases`: `define` and every later phase, `units: []`, `after_plan: false`;
  - `reason`: `the plan-lock commit <sha> is missing; approve the spec and the plan again`;
  - a move to `define` when the change is past it. In `define` it posts the comment without a move, so approving define does not trigger a second return from `plan`.
- When that comment already exists, `planLegacyMissing` returns `undefined`, `planCompletion` finishes a failed move, and no digest is compared until a new plan gate records digests. This fail-closed state is sticky: `failedClosed` holds even when `hasCommit(head_sha)` becomes true again, so the runner reads no digests and `planNewCascade` plans none.
- Why `define`: without a baseline nobody knows which requirements changed since the lock.
- Why `git cat-file -e <sha>^{commit}` (exit 128 = absent): it reads by sha, so reachability does not matter. Only the legacy path and the `Base` fallback (D3) use it.
- `unit_finish` refuses outside a `per: unit` phase:
  - the phase check runs first in its `precheck`, before `finishGateRefusal`;
  - `notPerUnit` is also added to `RUN_RULES` and `RECONCILE_RULES`;
  - the tick path re-reads the phase right before the body write, so a cascade from another session during `Verify` cannot be ticked past (unit-evidence delta).

### D7. Triggers
`runSpecCascade(session)` runs after `pollApprovals` in `startSession` (`src/hooks/session.ts`) and `runNextCommand` (`src/commands/next.ts`). In `runSpecGate` it runs right after `prepareWrite()` returns ok and before `requireChange`; when it wrote, `runSpecGate` resolves the change from the refreshed session. In `unit_finish` it runs inside `lockedEvidenceCall` through a new optional `before(w)` hook called right after `prepareWrite()` (so it holds the evidence lock); `unit_start` and `lane_merge` pass none. The target guard mirrors `pollTarget` (forge connected, not read-only, no account block, valid pack, card is a change, change state not stale) without importing `tools/`. `lockedEvidenceCall` takes an options object `{ where?, before? }` instead of a seventh positional parameter.
- Why not inside `Session.refresh()`: refresh runs from every write tool and must stay read-mostly; the issue names exactly these four triggers.
- The cascade's writes are its own: `prepareWrite`'s "nothing is written before ok" still holds, and a tool that then refuses writes nothing itself.

### D8. Question path without a requirement step
- `Answered.changesRequirement`, `QuestionSnapshot.requirements`, `ApprovalRequest.question.requirements`, `readRequirements` and `requirementNames` are removed. A stored snapshot with `requirements` still parses (extra key ignored).
- In-session `select` flow: `askChangedRequirement` and `RequirementPick` are removed. The dialog drops the `requirement` editor, the `pickRequirement` action, the requirement rows, the `canSubmit` requirement rule and `DialogModel.requirements`.
- `complete-question.ts` keeps `classOf`, `answeredBody` (answer line only) and `applyQuestion`; `cascade`, `coveringUnits`, `needsMoveBack` and `countsAsIteration` are deleted in Task 2. Task 3 writes `needsMoveBack` again in `spec-cascade-plan.ts` (same logic); `countsAsIteration` and `coveringUnits` are not needed.
- The `question` comment has no `changes_requirement`; `complete.ts` drops the "Changes requirement" human field.
- Forge: `parseAnswer` returns the error `--changes was removed: edit the spec instead; livespec cascades requirement edits from the spec diff` when any token is `--changes`; it surfaces as the existing card warning. `forge-text.ts` drops the flag.
- Docs: README files and `docs/architecture.md` lose the flag and describe the spec-diff cascade; the `questions-and-stuck` Purpose line is rewritten at sync.

## Risks / Trade-offs

- [Two sessions or machines run the cascade at the same moment on the same edit] → Both may post the same `spec.<id>` and `change_iterations` rises by two; same known gap as `pollApprovals`. Single-flight removes it within a session.
- [Spec edits made in `plan`, after the define gate and before the first lock, no longer cascade] → In scope by the issue ("once a plan lock exists"); the plan gate reviews the specs as they are, and later edits cascade from the first lock on.
- [The integration branch changed a requirement after the lock and the change then adopts exactly that text, before any cascade named it] → Excluded by design: it is indistinguishable from a merge. Review checks still see the diff.
- [Changes locked before this release whose lock commit is gone cost a define and a plan re-approval; done units stay ticked] → Migration only; every later plan gate records digests and ignores git history.
- [A capability first covered after the lock (amendment) is not compared until a plan gate records it] → The amendment itself is human-approved; the next plan approval brings it into scope.
- [A requirement changed on the integration branch that a done unit covers is not re-verified] → Out of scope; `change_sync` re-runs `Verify` for initiative changes. Known gap for plain changes.
- [The integration ref may be older than what HEAD merged (fetch failed, offline)] → Another change's edit merged into HEAD then counts as this change's own and cascades once; the best-effort fetch makes this rare, and the cascade is visible and named on the card.
- [Whitespace collapse also applies inside fenced code in a requirement, and to `change_sync`] → A whitespace-only edit in a code block no longer counts for either; accepted, consistent with the issue's "whitespace-only edit does not count".
- [Uncommitted spec edits are not seen] → `unit_finish` requires a clean tree and `spec_gate` runs the detector first, so the edit is caught once committed.
- [Old pending forge requests still show `--changes` in their text] → The command is refused with a message naming the replacement.
- [`unit_finish` now refuses outside `build`] → Only reachable after a cascade moved the change back; the unit is finished again in `build`.
- [A partial cascade in a pack whose define phase has `gate: none` does not complete its move back] → custom packs only; the `stale` comment already invalidates later gate results, so later gates refuse.
- [An identical amendment and re-lock after a cascade lets a pre-cascade receipt re-tick a unit without rerunning Verify] → pre-existing for every stale source (answers, change_sync); out of scope for #63; follow-up issue.

## Migration Plan

No data migration. Existing `question` comments with `changes_requirement` and old `stale` comments with id `Q<n>` stay readable and keep counting in `change_iterations`. Rollback is a plain revert. The `--changes` refusal is a breaking change of the forge command grammar and goes in `CHANGELOG.md`.

## Open Questions

None.
