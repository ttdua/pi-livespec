# Question Cascade Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Answering a question takes one step, and the requirement cascade is derived from the spec diff after the plan lock through one detector shared with `change_sync`, with a recorded digest baseline that integration-branch merges and rebases do not disturb.

**Architecture:** `src/engine/requirement-diff.ts` computes per-requirement content digests at a git revision and compares two digest maps; `change_sync` and the cascade share it. The plan gate request records the digests at the HEAD it is bound to, and every cascade `stale` record carries the digests it acknowledged, so the baseline never depends on git history. A pure planner (`src/interaction/spec-cascade-plan.ts`) and an effect runner (`src/interaction/spec-cascade.ts`) turn HEAD digests that differ from the acknowledged ones, minus integration-branch edits, into `stale` → untick → phase-move effects. Locks approved before this release compute their baseline from the lock commit, or fail closed to `define` when it is gone. The question path loses every requirement field and step, and `unit_finish` refuses outside a `per: unit` phase.

**Tech Stack:** TypeScript (Bun, `tsc --noEmit`), Vitest, git CLI through `src/engine/git.ts`.

## Global Constraints

- Prose of user-facing strings, comments and docs in English.
- Bun for scripts: `bun run typecheck`, `bun run test` (Vitest).
- No new dependency and no new forge marker kind; the cascade reuses `stale`.
- Every cascade writes in this order: `stale` comment, then one versioned body write, then `advancePhase` (design D5).
- Requirement id format: `<capability>/Requirement: <name>`, the existing `Covers` format. `Covers` entries are trimmed before matching.
- Removal message for the forge flag (exact): `--changes was removed: edit the spec instead; livespec cascades requirement edits from the spec diff`.
- Integration updates are merges, never rebases (flow-engine). The cascade must still work when a branch was rebased anyway.

## Review Focus

These are the failure modes that the scenario tests alone do not pin down.

- **Spec file deleted at HEAD:** `requirementDigests` returns no entry for it, so `changedIds` reports every acknowledged requirement as removed, and nothing throws. Test in Task 1: `missing file at HEAD yields no digests`.
- **Parallel triggers in one session:** they share one run, so exactly one `stale` comment is posted. Test in Task 3: `parallel calls share one run`.
- **Change with no define gate:** a locked change in `build` that never had a define gate (a fixture or `gate: none` pack) is never moved. Test in Task 3: `locked, no define gate, no spec stale → none`.
- **Integration ref missing locally:** `origin/<branch>` is absent (no remote or never fetched), so the exclusion falls back to `Base` and the run does not throw. Test in Task 3: `exclusion falls back to Base without origin ref`.
- **`Covers` entry with extra spaces:** an entry such as `rate-limit/Requirement:  Per-IP cap` still matches its requirement. Test in Task 3: `covers entry with extra whitespace matches`.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `requirementContent` | modified (moved from `sync.ts`) | `(r: Requirement) => string`: JSON of `{ text, scenarios: [{ name, given, when, then }] }`, with every whitespace run in `text` and in each GIVEN/WHEN/THEN line collapsed to one space and trimmed | no |
| `requirementDigests` | new | `(git: Git, rev: string, capabilities: string[]) => Promise<Record<string, string>>`: id `<capability>/Requirement: <name>` → sha256 hex of `requirementContent`; a missing file contributes nothing; read with the lenient `parseSpec` | no |
| `changedIds` | new | `(before: Record<string, string>, after: Record<string, string>) => string[]`: ids whose value differs, including ids on one side only; sorted | no |
| `REMOVED_DIGEST` | new | `"removed"`: the digest recorded for an id absent at HEAD | no |
| `capabilityOf` | new (moved) | `(covers: string) => string \| undefined`: the text before `COVERS_SEPARATOR` (`"/Requirement:"`), trimmed; undefined when empty | no |
| `declaredCapabilities` | modified (moved to `src/core/change.ts`) | `(change: Change) => string[]` | no |
| `requirementScope` | new | `(change: Change) => string[]`: `declaredCapabilities` ∪ `capabilityOf` of every unit `Covers`, sorted, deduplicated | no |
| `Git.hasCommit` | new | `hasCommit(sha: string): Promise<boolean>`: `git cat-file -e <sha>^{commit}`; exit 128 means false. Used only by the legacy path and the `Base` fallback | no |
| `GateSnapshot` | modified | adds `requirements?: Record<string, string>; requirement_scope?: string[]`, set for `target === "plan"` | yes (request record) |
| plan `gate` comment data | modified | adds `requirements` and `requirement_scope`, copied from the request snapshot, or computed at HEAD for a self gate | yes (forge record format) |
| `GateCommentInput` | modified | adds `requirements?: Record<string, string>; requirementScope?: string[]` | no |
| `selfGateComment` | modified | `(state, target, now, agentSkills, record?: { requirements: Record<string, string>; scope: string[] }) => string` (stays sync; caller computes digests). Task 3: the record type is `RequirementRecord`, built by `requirementRecord(git, rev, change)` in `requirement-diff.ts`, shared by `buildRequest` and `passSelf` | no |
| `gateRequest` | modified | input gains `requirements?: { requirements: Record<string, string>; scope: string[] }`, computed by `buildRequest` for `plan` | no |
| `LockState.baseline` | new | `baseline?: { at: number; commentId: string; headSha?: string; requirements?: Record<string, string>; scope?: string[] }`: the gate `lockOf` uses; `at` is its index in `marked` | no |
| spec-cascade `stale` data | new usage | `{ reason: "requirements changed since the plan lock: <ids>", phases: ["define", …later], units: string[] (every covering unit), after_plan: boolean, requirements: Record<string, string> (digest at HEAD or REMOVED_DIGEST) }`, id `spec.<12 hex of sha256 over baseline commentId, count of spec-cascade comments after the baseline, sorted "id=digest" lines>`, written with `writeMarked` | yes (forge record format) |
| legacy baseline `stale` data | new usage | `{ reason: "the plan-lock commit <sha> is missing; approve the spec and the plan again", phases: ["define", …later], units: [], after_plan: false, baseline: <sha> }`, id `baseline.<sha12>` | yes (forge record format) |
| `isSpecCascade` / `isBaselineStale` | new | `(m: MarkedComment) => boolean`: `kind === "stale"` and id prefix `spec.` / `baseline.` | no |
| `CascadeInput` | new | `{ change: Change; marked: MarkedComment[]; phase: PhaseState; pack: Pack; lock: LockState; baseline: Record<string, string> \| undefined; scope: string[]; heads: Record<string, string>; reference: Record<string, string> \| undefined }`: `baseline` = the gate record, else the legacy digests, else undefined (commit gone) | no |
| `acknowledgedDigests` | new | `(input: CascadeInput) => Record<string, string>`: `input.baseline` overlaid, in comment order, by the `requirements` of every spec-cascade `stale` after `lock.baseline.at`; an overlaid `REMOVED_DIGEST` deletes the id | no |
| `coversId` | new | `(entry: string) => string`: trims and collapses inner whitespace runs to one space; used by the cascade and `change_sync` to match `Covers` entries with ids | no |
| `excludedIds` | new | `(input: CascadeInput, changed: string[]) => Set<string>`: ids no spec-cascade comment after the baseline names, with `reference[id]` defined and `reference[id] === heads[id]` and `reference[id] !== baseline[id]` | no |
| `integrationRef` | new | `(session: Session, git: Git, base: string \| undefined) => Promise<string \| undefined>`: best-effort fetch, `remoteRef` check, `mergeBase("HEAD", "origin/<branch>")`, else `base` when `hasCommit(base)`. `base` is the `Base` of the issue body `readCascadeInput` just read (Task 3: passed in so the fallback never reads the cached card, which may predate a `change_sync`) | no |
| `SpecCascadePlan` | new | `{ kind: "none" } \| { kind: "cascade"; id: string; data: StaleData; untick: string[]; moveBack: boolean } \| { kind: "complete"; untick: string[]; moveBack: boolean } \| { kind: "legacy-missing"; id: string; data: StaleData; moveBack: boolean }` | no |
| `planSpecCascade` | new | `(input: CascadeInput) => SpecCascadePlan`; sub-planners `planLegacyMissing`, `planCompletion`, `planNewCascade` with the same signature returning `SpecCascadePlan \| undefined` | no |
| `needsMoveBack` | new (rewritten from `complete-question.ts`) | `(pack: Pack, phase: PhaseState) => boolean` | no |
| `runSpecCascade` | new | `(session: Session) => Promise<boolean>`: true when it wrote; never throws; single-flight through `Session.cascadeInFlight?: Promise<boolean>` | no |
| `lockedEvidenceCall` | modified | `(tool, unit, signal, precheck, body, opts?: { where?: "unit" \| "change"; before?: (w: WriteContext) => Promise<void> })`; `before` runs right after `prepareWrite` is ok, then `requireChange` reads the refreshed session; `lane-merge.ts` passes `{ where: "change" }` | no |
| `Answered.changesRequirement` | removed | field deleted | yes (approver contract) |
| `QuestionSnapshot.requirements`, `ApprovalRequest.question.requirements` | removed | fields deleted; stored snapshots that still carry the key parse | yes (request record) |
| `Command` (`answer`) | modified | `{ verb: "answer"; question: string; text: string; class?: QuestionClass }` | no |
| `/livespec answer` grammar | modified | `answer Q<n> <text> [--class blocking\|non-blocking]`; any `--changes` token is a parse error carrying the removal message | yes (forge CLI) |
| `question` comment data | modified | `changes_requirement` is no longer written | yes (forge record format) |
| dialog requirement step | removed | `DialogState.requirement`, `EditorName "requirement"`, action `pickRequirement`, `DialogModel.requirements` | no |
| `unit_finish` refusal | modified | phase checked first in `precheck`, and `notPerUnit` in `RUN_RULES` and `RECONCILE_RULES`; text as the existing rule: `The change is not in a per: unit phase (phase <id>); units are built in the build phase.`; the tick re-reads the phase before the body write | yes (tool behaviour) |

---

## Task 1: Shared requirement-diff detector (implements group 1)

**Covers:** 1.1, 1.2, 1.3, 1.4
**Difficulty:** Normal
**Blocked by:** none

**Files:**
- Create: `src/engine/requirement-diff.ts`, `tests/engine/requirement-diff.test.ts`
- Modify:
  - `src/initiatives/sync.ts`: remove `requirementContent`, `requirementsAt`, `changedRequirements`, `Requirements` and `COVERS_SEPARATOR`.
  - `src/engine/git.ts`: add `hasCommit`.
  - Every `Git` fake; find them with `grep -rln "showFile:" tests src`. Fakes default `hasCommit` to `true`.
  - `src/core/change.ts`, plus `src/engine/checks.ts` and `src/subagents/source-kit.ts` (re-export kept for its three importers), for `declaredCapabilities`.
  - `tests/engine/git.test.ts`.

**Interfaces:**
- Produces: `requirementContent`, `requirementDigests`, `changedIds`, `REMOVED_DIGEST`, `coversId`, `capabilityOf`, `COVERS_SEPARATOR`, `requirementScope`, `Git.hasCommit` and `declaredCapabilities` (from `core/change.ts`).

- [ ] **Step 1: Write failing tests** in `tests/engine/requirement-diff.test.ts`. Use a temp git repo, following the repo-helper pattern of `tests/engine/git.test.ts`. Commit `specs/rate-limit/spec.md` with `Per-IP cap` (two-line text, one scenario) and `Burst`, then compare `requirementDigests` before and after each edit with `changedIds`:
  - `text edit is a change`: `["rate-limit/Requirement: Per-IP cap"]`.
  - `scenario THEN edit is a change`.
  - `added and removed`: both ids are listed.
  - `re-wrapped and re-indented text is not a change`: join the two text lines into one, indent them, and add a blank line between paragraphs. Expect `[]`.
  - `shifted lines are not a change`: insert 5 lines above the requirement. Expect `[]`.
  - `missing file at HEAD yields no digests`.
  - `digests are sha256 hex of requirementContent`.
- [ ] **Step 2: Run** `bunx vitest run tests/engine/requirement-diff.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3: Implement** `src/engine/requirement-diff.ts`. Move the code out of `sync.ts` and collapse whitespace with `.replace(/\s+/g, " ").trim()` on the text and on each GIVEN/WHEN/THEN string. `requirementDigests` reads each capability's file at `rev` with `git.showFile`, in parallel.
- [ ] **Step 4: Run** the detector test. Expect PASS.
- [ ] **Step 5: Refactor `sync.ts`.** `staleUnits` keeps `s.oldBase === s.base ? new Set() : …`, builds the set from `changedIds(await requirementDigests(s.git, s.oldBase, caps), await requirementDigests(s.git, s.base, caps))`, and matches `Covers` with `coversId`. Run `bunx vitest run tests/tools/change-sync.test.ts` and expect PASS with no test edits.
- [ ] **Step 6: Add `hasCommit`.**
  - Write the tests in `tests/engine/git.test.ts`:
    - HEAD returns `true`.
    - A commit dropped by `git reset --hard HEAD~1` returns `true`.
    - `"0".repeat(40)` returns `false`.
  - Run them and expect FAIL.
  - Implement with `run(["cat-file", "-e", END_OF_OPTIONS, \`${sha}^{commit}\`], EXIT_NO_OBJECT) !== undefined`.
  - Add `hasCommit` to every fake, defaulting to `true`.
  - Run again and expect PASS.
- [ ] **Step 7: Move** `declaredCapabilities` to `src/core/change.ts`, import it in `checks.ts`, and re-export it from `source-kit.ts`. Add `requirementScope` with a test (`declared plus covers capabilities, deduplicated`). Run `bun run typecheck` and expect no errors. Run `bunx vitest run tests/engine` and expect PASS.
- [ ] **Step 8: Commit** `refactor(engine): share requirement digests between change_sync and cascades`.

---

## Task 2: Question path without a requirement step (implements group 2)

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5
**Difficulty:** Normal
**Blocked by:** Task 1 (both edit `src/tools/spec-question.ts` and `declaredCapabilities` imports)

**Files:**
- Modify:
  - `src/interaction/approver.ts`, `src/tools/spec-question.ts` and `src/interaction/in-session.ts`.
  - `src/interaction/dialog/{state,keys,view,model,result,host}.ts`.
  - `src/interaction/commands.ts`, `src/interaction/forge-match.ts` and `src/interaction/forge-text.ts`.
  - `src/interaction/complete-question.ts` and `src/interaction/complete.ts`.
- Test:
  - `tests/interaction/{in-session,commands,forge,forge-text,poll,complete}.test.ts`.
  - `tests/interaction/dialog/{state,keys,model,view}.test.ts`.
  - `tests/tools/spec-question.test.ts`, `tests/tools/request-summary.test.ts`, `tests/interaction/chain.test.ts` and `tests/interaction/dialog/host.test.ts` (drop `requirements` from fixtures).
  - `tests/e2e/gates-flow.test.ts`.
  - `tests/tools/no-answer-params.test.ts` (unchanged; it must stay green).

**Interfaces:**
- Produces the trimmed `Answered`, `QuestionSnapshot`, `ApprovalRequest.question` and `Command` (see Contracts).
- `complete-question.ts` keeps only `classOf`, `answeredBody` (answer line only) and `applyQuestion`.

- [ ] **Step 1: Update tests first**, each asserting the new behaviour:
  - `commands.test.ts`:
    - `answer Q2 use per-user limits --changes rate-limit/Requirement: Per-IP cap` returns `{ error: "<removal message>" }`.
    - `answer text with --changes token is refused` (`answer Q2 keep --changes off`) returns the same error.
    - `answer Q2 use per-user limits --class non-blocking` returns `{ verb: "answer", question: "Q2", text: "use per-user limits", class: "non-blocking" }`.
  - `forge.test.ts` and `poll.test.ts`: a writer's `--changes` answer leaves the request pending, and the card warning contains `--changes was removed`.
  - `forge-text.test.ts`: the question request text contains `/livespec answer Q1 <text> [--class blocking|non-blocking]` and no `--changes`.
  - `in-session.test.ts`:
    - Picking a candidate makes one `select` call and no `input` call, and the verdict has no `changesRequirement`.
    - An own answer `no limit` makes one `input` call.
  - Dialog tests:
    - `dialog/state.test.ts`: `canSubmit` is ok right after a candidate is picked. An empty own answer gives `{ ok: false, reason: "Type your answer first" }`.
    - `dialog/model.test.ts`: the model has no `requirements`.
    - `dialog/view.test.ts`: the Review tab has no line `Does the answer change a requirement?`.
    - `dialog/keys.test.ts`: Enter on Review submits the question.
  - `tests/tools/spec-question.test.ts`:
    - Drop `CHANGES_TITLE` and the `select` handlers that answered it.
    - The snapshot expectation becomes `{ id: "Q3", text: … }` with no `requirements`.
    - Replace "Answer sends the change back", "Cascade before the plan" and "Second answer while in define" with `Answer in build changes nothing else`: U3 stays done, there is no `stale` comment and the labels are unchanged.
  - `tests/tools/request-summary.test.ts`: call `questionRequest(state, q, { body: "", now: NOW })`.
  - `complete.test.ts`:
    - The answer writes only the answer line.
    - The `question` data has no `changes_requirement`.
    - A stored snapshot with `requirements: [...]` still completes.
  - `tests/e2e/gates-flow.test.ts`:
    - In "full gate flow", replace step 7 with a plain `/livespec answer Q1 per client token`. Assert Q1 is answered and the phase is unchanged.
    - Seed 5 `stale` comments with `after_plan: true` directly to keep the cap → `spec_stuck` → `choose A` chain.
    - In "Stale before the first lock", seed `writeMarked("stale", "Q1", { reason: "Q1", phases: ["define","plan","build","review","ship","close"], units: ["U1"], after_plan: false })` and move the label to define directly, instead of the `--changes` answer.
- [ ] **Step 2: Run** `bunx vitest run tests/interaction tests/tools/spec-question.test.ts tests/tools/request-summary.test.ts tests/e2e/gates-flow.test.ts`. Expect the new assertions to FAIL.
- [ ] **Step 3: Implement.**
  - Delete the fields and helpers listed under Files.
  - `parseAnswer` returns the removal error when any token equals `--changes`.
  - `forge-match.ts` drops `a.changesRequirement`, and `forge-text.ts` drops the flag.
  - `complete.ts` drops `["Changes requirement", "changesRequirement"]`.
  - `complete-question.ts` deletes `cascade`, `coveringUnits`, `needsMoveBack` and `countsAsIteration`.
- [ ] **Step 4: Run** `bunx vitest run tests/interaction tests/tools tests/e2e/gates-flow.test.ts` and expect PASS. Run `bun run typecheck` and expect no errors.
- [ ] **Step 5: Commit** `feat(questions)!: answer questions in one step; drop --changes`.

---

## Task 3: Spec-diff cascade and plan-gate digests (implements group 3)

**Covers:** 3.1, 3.2, 3.3, 3.4
**Difficulty:** Hard
**Blocked by:** Task 1, Task 2

**Files:**
- Create: `src/interaction/spec-cascade-plan.ts`, `src/interaction/spec-cascade.ts`, `tests/interaction/spec-cascade-plan.test.ts` and `tests/interaction/spec-cascade.test.ts`.
- Modify:
  - `src/tools/spec-gate.ts`: `buildRequest` computes the plan record and `gateRequest` stores it in the snapshot; `passSelf` computes it for `selfGateComment`.
  - `src/interaction/approver.ts`: `GateSnapshot` fields.
  - `src/interaction/complete-gate.ts`: copy the snapshot record into the approved plan `gate` comment.
  - `src/engine/locks.ts`: `LockState.baseline`, from the gate `lockOf` uses (`gateData` parses `requirements` and `requirement_scope`).
  - `src/hooks/session.ts`: the `cascadeInFlight` field only.
  - `tests/engine/{iterations,locks}.test.ts` and the plan-gate tests in `tests/interaction/complete.test.ts` and `tests/tools/spec-gate.test.ts`.

**Interfaces:**
- Consumes:
  - From Task 1: `requirementDigests`, `changedIds`, `REMOVED_DIGEST`, `capabilityOf`, `requirementScope` and `Git.hasCommit`.
  - Existing: `deriveLocks` and `validApproval`, `untickUnit`, `advancePhase`, `phasesAfter`, `writeMarked`, `readMarkedComments`, `integrationBranch` and `Git.mergeBase`.
- Produces: `planSpecCascade`, `runSpecCascade`, `SpecCascadePlan`, `CascadeInput`, `acknowledgedDigests`, `excludedIds`, `isSpecCascade` and `isBaselineStale`.

Planner rules from design D3–D6, which the tests pin. `planSpecCascade` runs the sub-planners in order; the first that returns a plan wins.
1. **No lock:** `lock.baseline` undefined returns `none`.
2. **`planLegacyMissing`:** only when `input.baseline` is undefined, meaning the gate has no record and its commit is gone.
   - A `baseline.<sha12>` comment after `lock.baseline.at` returns `undefined`, so `planCompletion` can finish it. Without a baseline, `planNewCascade` then returns `none`.
   - Otherwise it returns `legacy-missing`, with `moveBack` = `needsMoveBack(pack, phase)` (false in `define`: the comment is posted without a move).
3. **`planCompletion`:** looks at the spec-cascade and legacy-baseline comments after `lock.baseline.at`.
   - `untick`: the units they name that are still in `lock.staleUnits` and still done.
   - `moveBack`: `needsMoveBack`, a comment listing `define` that is newer than the latest define gate passing `validApproval`, and a define phase gate other than `none` in the pack.
   - It returns `complete` when either is non-empty or true; otherwise `undefined`.
4. **`planNewCascade`:**
   - `changed` = `changedIds(acknowledgedDigests(input), heads)` minus `excludedIds(input, changed)`.
   - An empty `changed` returns `none`.
   - `data.requirements` holds each changed id's digest at HEAD, or `REMOVED_DIGEST`.
   - `data.units`: every unit whose trimmed `Covers` names a changed id. `untick`: the done subset.
   - `moveBack = after_plan = needsMoveBack`.
   - The id follows the Contracts row.

The runner applies one plan, re-reads the input, and plans once more. A `complete` followed by a `cascade` is therefore handled in one trigger.

- [ ] **Step 1: Plan-gate digests.**
  - Write the tests:
    - `spec-gate.test.ts`: `spec_gate plan` sends a request whose snapshot holds `requirements` equal to `requirementDigests` at HEAD and `requirement_scope` equal to `requirementScope`. A define gate request holds neither. A self plan gate comment holds both.
    - `complete.test.ts`: an approved plan gate comment copies `requirements` and `requirement_scope` from the request snapshot, without reading git (the fake `showFile` is never called). An approved plan request with no record in its snapshot, as stored before this release, writes neither field.
    - `locks.test.ts`: `baseline survives a later stale listing plan` (`lock.baseline` is still set while `gates.plan` is undefined), and `requirements` and `scope` are parsed.
  - Run them and expect FAIL.
  - Implement:
    - `buildRequest` computes `{ requirements: await requirementDigests(w.session.git, state.git.head, scope), scope }` for `target === "plan"`, where `scope = requirementScope(state.change)`. `gateRequest` stores it in the snapshot as `requirements` and `requirement_scope`.
    - `applyGate` copies them into `GateCommentInput` when `approvedPlan`, and `gateComment` writes them.
    - `passSelf` computes the same record and passes it to `selfGateComment`.
  - Run again and expect PASS.
- [ ] **Step 2: Write planner tests** in `tests/interaction/spec-cascade-plan.test.ts`. They are pure; build `CascadeInput` directly.
  - `no lock → none`.
  - `covered done unit → cascade`: `data.units` `["U3"]`, `untick` `["U3"]`, `moveBack` true, `after_plan` true (build).
  - `uncovered edit → cascade with no units`: `moveBack` true.
  - `pending unit covering the edit is named but not unticked`: U4 is pending, so `data.units` includes U4 and `untick` excludes it.
  - `same digest already acknowledged → none`.
  - `further edit (new digest) → cascade naming U3 again`.
  - `baseline A, edits B, A, B → three cascades with distinct ids`.
  - `revert to the baseline text after a cascade → cascade`.
  - `removed requirement → cascade with REMOVED_DIGEST`.
  - `removed requirement acknowledged → none on rerun`.
  - `removed then re-added → cascade`.
  - `capability outside scope is not compared`.
  - `integration edit not acknowledged → excluded`.
  - `own edit reverted equals reference → not excluded`: the id is acknowledged.
  - `second edit while in define → cascade with after_plan false`.
  - `partial earlier cascade → complete` (U3 still ticked, phase build).
  - `locked, no define gate, no spec stale → none` (build).
  - `legacy commit gone in build → legacy-missing`.
  - `legacy comment exists, move failed → complete with moveBack`.
  - `legacy comment exists, in define → none`.
  - `legacy commit gone in define → legacy-missing without moveBack`.
  - `define gate none in pack → completion does not move back`.
  - `covers entry with extra whitespace matches`.
  - `id is stable across input order`.
- [ ] **Step 3: Run** `bunx vitest run tests/interaction/spec-cascade-plan.test.ts`. Expect FAIL.
- [ ] **Step 4: Implement** `src/interaction/spec-cascade-plan.ts`: the three sub-planners, `planSpecCascade` as their composition, `acknowledgedDigests`, `excludedIds`, `needsMoveBack`, `isSpecCascade`, `isBaselineStale`, and the id and reason builders. Run the tests and expect PASS.
- [ ] **Step 5: Write runner tests** in `tests/interaction/spec-cascade.test.ts`, using the memory forge and a temp git repo with an `origin` remote (pattern of `tests/tools/change-sync.test.ts`).
  - `applies stale, untick, move in order`: the comment comes before the body write, which comes before the labels. `deriveIterations` count is 1.
  - `rerun at same HEAD writes nothing`.
  - `partial cascade plus a new edit are both applied in one run`: one completion, one new comment, iterations 1.
  - `untick conflict then rerun completes`:
    - The first body write conflicts.
    - The second run unticks and moves.
    - Exactly one `spec.*` stale exists, and iterations is 1.
  - `parallel calls share one run`: `Promise.all([runSpecCascade(s), runSpecCascade(s)])` gives one comment.
  - `rebased branch, lock commit gone, nothing changed → nothing written`: the record is present and `hasCommit(head_sha)` is false.
  - `rebased branch, lock commit gone, edit → cascade`.
  - `own edit reverted to the lock text cascades although main never touched it`.
  - `hand merge of main ignored`:
    - `main` edits `Burst` and is pushed, and the branch merges `origin/main`.
    - `Base` is unchanged.
    - Nothing is written.
  - `conflict combined from both sides cascades`.
  - `stale origin ref still excludes after the fetch`.
  - `exclusion falls back to Base without origin ref, and when merge-base fails`.
  - `legacy lock with commit present → compares from it`.
  - `legacy lock with commit gone → define`: one `baseline.*` stale listing `define` and later phases, label `define`, iterations 0.
  - `legacy move failure then rerun moves to define`.
  - `read-only forge skips`: no forge write, and it returns false.
  - `failure is recorded, not thrown`: `createComment` throws, the run resolves false, and `session.record` received `"spec-cascade"`.
  - `unchanged spec makes no fetch`: the fake `git.fetch` is not called.
- [ ] **Step 6: Implement `src/interaction/spec-cascade.ts`.**
  - `cascadeTarget(session)` mirrors `pollTarget`: forge connected and not read-only, no account block, valid pack, card is a change, `state.stale` false.
  - `readCascadeInput` reads marked comments fresh, after `session.comments?.invalidate`. It sets `baseline` to the gate record when one exists. Otherwise, when `hasCommit(headSha)`, it uses `requirementDigests(git, headSha, requirementScope(change))`; otherwise `baseline` is undefined. `scope` is the record's `scope`, or `requirementScope(change)` for a legacy lock. `heads` = `requirementDigests(git, "HEAD", scope)`. `reference` = the same at `integrationRef`, computed only when `changedIds(acknowledged, heads)` is non-empty, else undefined.
  - `integrationRef` skips when `session.config.project` is null, fetches best-effort, checks `git.remoteRef`, and falls back to `Base` when `hasCommit(Base)`.
  - `applyCascade` runs `postStale` via `postOnce` semantics over the fresh marked list, then `untickUnits` (one `updateIssueBody` with version; a conflict stops the run and the next run completes), then `moveBack` via `advancePhase(…, "define", pack)`.
  - `runSpecCascade` is single-flight on `session.cascadeInFlight`. It applies a plan, re-reads, and plans once more. It catches into `session.record("spec-cascade", e)` and, after a write, calls `session.comments?.invalidate(n)` and `session.refresh()`.
  - Run the tests and expect PASS.
- [ ] **Step 7: Add engine tests.**
  - `iterations.test.ts`: a `spec.*` stale with `after_plan: true` counts once.
  - `locks.test.ts`:
    - A `spec.*` stale naming U3 gives `staleUnits` `["U3"]`, cleared by a later approved amendment.
    - A `baseline.*` stale listing `define…` invalidates the define and plan gate results but leaves `locked` intact.
  - Run them and expect PASS with no production change.
- [ ] **Step 8: Run** `bun run typecheck`. Expect no errors.
- [ ] **Step 9: Commit** `feat(questions-and-stuck): cascade requirement edits from recorded digests`.

---

## Task 4: Phase rule for unit_finish (implements group 4)

**Covers:** 4.1
**Difficulty:** Easy
**Blocked by:** none

**Files:**
- Modify: `src/evidence/refusals.ts`, `src/tools/unit-finish.ts` (`precheck` order, phase re-read before the tick).
- Test: `tests/evidence/refusals.test.ts` and `tests/tools/unit-finish.test.ts`.

- [ ] **Step 1: Write tests.**
  - `refusals.test.ts`: a started unit with phase `define` gives a finish refusal containing `not in a per: unit phase (phase define)`, and so does a receipted unit with phase `plan`.
  - `unit-finish.test.ts`: `Not in a per-unit phase` and `Receipted unit outside a per-unit phase`. `Verify` is not spawned and the status line stays pending. Also `phase changed during Verify is not ticked`: the forge labels move to define while the fake `Verify` runs, and the result is a refusal with the status line still pending and the receipt posted.
- [ ] **Step 2: Run** `bunx vitest run tests/evidence/refusals.test.ts tests/tools/unit-finish.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Check the phase first in `precheck`, before `finishGateRefusal`. Also add `notPerUnit` to `RUN_RULES` and `RECONCILE_RULES`, and re-read the labels right before the tick write.
- [ ] **Step 4: Run** `bunx vitest run tests/evidence tests/tools` and expect PASS. Existing finish tests run in `build`, so they are unaffected.
- [ ] **Step 5: Commit** `feat(unit-evidence): unit_finish refuses outside a per-unit phase`.

---

## Task 5: Triggers and end-to-end (implements group 5)

**Covers:** 5.1, 5.2, 5.3
**Difficulty:** Normal
**Blocked by:** Task 3, Task 4

**Files:**
- Modify: `src/hooks/session.ts` (`startSession`), `src/commands/next.ts`, `src/tools/spec-gate.ts` (`runSpecGate`), `src/tools/unit-tool.ts` (`lockedEvidenceCall` options object), `src/tools/unit-finish.ts` (passes `before`), `src/tools/unit-start.ts` and `src/tools/lane-merge.ts` (new call shape), and the `Git` fakes (`hasCommit` defaults to `true`).
- Create: `tests/e2e/spec-cascade.test.ts`.
- Test: the session start test in `tests/hooks/` or `tests/extension.test.ts`, `tests/commands/next.test.ts`, `tests/tools/spec-gate.test.ts` and `tests/tools/unit-finish.test.ts`.

**Interfaces:**
- Consumes `runSpecCascade(session): Promise<boolean>`, which refreshes itself after a write.

- [ ] **Step 1: Write trigger tests.**
  - `session_start` and `/livespec next` call the cascade after `pollApprovals`.
  - `spec_gate` calls it after `prepareWrite` and before the change is resolved: a covered edit in `build` makes `spec_gate build` refuse because the phase is now `define`.
  - `unit_finish` calls it inside the evidence lock, before `requireChange`.
  - `unit_start` and `lane_merge` do not call it.
- [ ] **Step 2: Write the E2E tests** in `tests/e2e/spec-cascade.test.ts`, using the harness of `tests/e2e/gates-flow.test.ts`. Write one test per cascade scenario of the deltas, as listed under Scenario → test.
- [ ] **Step 3: Run** `bunx vitest run tests/e2e/spec-cascade.test.ts` together with the trigger tests. Expect FAIL.
- [ ] **Step 4: Implement the four call sites.**
- [ ] **Step 5: Run** the same tests. Expect PASS.
- [ ] **Step 6: Run** `bun run typecheck && bun run test`. Expect 0 failures. Fixtures that seed a plan gate with a fake `head_sha` (for example `tests/engine/snapshot.test.ts`) rely on the fake `hasCommit` returning true. Fix any fixture that commits a spec after seeding a lock by adding a commit before the lock.
- [ ] **Step 7: Commit** `feat(questions-and-stuck): run the spec-diff cascade at session start, next, spec_gate and unit_finish`.

---

## Task 6: Docs (implements group 6)

**Covers:** 6.1, 6.2
**Difficulty:** Easy
**Blocked by:** Task 2, Task 3, Task 4, Task 5

**Files:**
- Modify:
  - `README.md` and `README.vi.md`: the command table and the answer section.
  - `docs/architecture.md`: the forge commands paragraph and the cascade paragraph.
  - `CHANGELOG.md`: Unreleased.

- [ ] **Step 1: Edit the grammar** to `answer Q<n> <text> [--class blocking|non-blocking]`. Replace the requirement step and the `--changes` example with:
  - answer in one step;
  - to change a requirement, edit `specs/<capability>/spec.md`;
  - after the plan lock, livespec cascades the edit.
- [ ] **Step 2: Rewrite the architecture cascade paragraph** to cover:
  - the baseline is the requirement digests recorded by the plan gate request;
  - the shared `requirementDigests` / `changedIds`;
  - acknowledged digests and once per content;
  - the merge-base exclusion;
  - locks without digests: computed from the lock commit, fail-closed to `define` when it is gone;
  - the triggers;
  - the `unit_finish` phase rule.
- [ ] **Step 3: Update `CHANGELOG.md`** under Unreleased:
  - `### Breaking`: `/livespec answer --changes` is removed (refused with a message), and `unit_finish` refuses outside `build`.
  - `### Changed`: the requirement cascade is derived from the spec diff, and plan gates record requirement digests.
- [ ] **Step 4: Verify** `grep -n -- "--changes" README.md README.vi.md docs/architecture.md` returns no match.
- [ ] **Step 5: Commit** `docs: spec-diff cascade and removed --changes`.

---

## Scenario → test

### questions-and-stuck

| Scenario | Test |
|---|---|
| Answer written back | `tests/interaction/complete.test.ts` |
| Answer in build changes nothing else | `tests/tools/spec-question.test.ts`; `tests/e2e/spec-cascade.test.ts` |
| Human reclassifies | existing `tests/tools/spec-question.test.ts` "Human reclassifies" |
| Whitespace and moved lines ignored | `tests/engine/requirement-diff.test.ts`; `tests/e2e/spec-cascade.test.ts` |
| Edit before the lock | `tests/interaction/spec-cascade-plan.test.ts` (`no lock → none`); `tests/e2e/spec-cascade.test.ts` |
| Plan gate records the digests | `tests/tools/spec-gate.test.ts`; `tests/interaction/complete.test.ts` |
| Rebased branch on a fresh clone | `tests/interaction/spec-cascade.test.ts` (`rebased branch, lock commit gone, nothing changed`); `tests/e2e/spec-cascade.test.ts` |
| Edit after a rebase | `tests/interaction/spec-cascade.test.ts` (`rebased branch, lock commit gone, edit → cascade`); `tests/e2e/spec-cascade.test.ts` |
| Capability covered after the lock | `tests/interaction/spec-cascade-plan.test.ts` (`capability outside scope is not compared`); `tests/e2e/spec-cascade.test.ts` |
| Edit merged by change_sync ignored | `tests/e2e/spec-cascade.test.ts` (merge via `change_sync`) |
| Hand merge of the integration branch ignored | `tests/interaction/spec-cascade.test.ts` (`hand merge of main ignored`); `tests/e2e/spec-cascade.test.ts` |
| Conflict resolved by combining both sides | `tests/interaction/spec-cascade.test.ts`; `tests/e2e/spec-cascade.test.ts` |
| Own edit reverted while main never touched it | `tests/interaction/spec-cascade-plan.test.ts`; `tests/interaction/spec-cascade.test.ts`; `tests/e2e/spec-cascade.test.ts` |
| Spec edit sends the change back | `tests/interaction/spec-cascade.test.ts`; `tests/e2e/spec-cascade.test.ts` (via `/livespec next`) |
| Edit no done unit covers | `tests/interaction/spec-cascade-plan.test.ts`; `tests/e2e/spec-cascade.test.ts` (via `spec_gate build`, which refuses) |
| Same edit cascades once | `tests/interaction/spec-cascade-plan.test.ts`; `tests/e2e/spec-cascade.test.ts` |
| Further edit of the same requirement | `tests/interaction/spec-cascade-plan.test.ts`; `tests/e2e/spec-cascade.test.ts` |
| Removed requirement cascades once | `tests/interaction/spec-cascade-plan.test.ts` (`removed requirement acknowledged → none on rerun`); `tests/e2e/spec-cascade.test.ts` |
| Edit reverted after a cascade | `tests/interaction/spec-cascade-plan.test.ts` (`revert to the baseline text after a cascade → cascade`); `tests/e2e/spec-cascade.test.ts` |
| Second edit while in define | `tests/interaction/spec-cascade-plan.test.ts`; `tests/e2e/spec-cascade.test.ts` |
| Retried cascade counts once | `tests/interaction/spec-cascade.test.ts` (`untick conflict then rerun completes`); `tests/e2e/spec-cascade.test.ts` (via `session_start`) |
| Old lock with its commit present | `tests/interaction/spec-cascade.test.ts` (`legacy lock with commit present`); `tests/engine/git.test.ts` (`hasCommit`) |
| Baseline commit missing | `tests/interaction/spec-cascade.test.ts` (`legacy lock with commit gone → define`); `tests/e2e/spec-cascade.test.ts` (started U2; `unit_finish` refuses; next step asks for the define gate) |
| Missing baseline handled once | `tests/interaction/spec-cascade-plan.test.ts` (`legacy comment exists, in define → none`); `tests/e2e/spec-cascade.test.ts` |
| Baseline commit missing in define | `tests/interaction/spec-cascade-plan.test.ts` (`legacy commit gone in define → legacy-missing without moveBack`); `tests/e2e/spec-cascade.test.ts` |
| Parallel triggers run once | `tests/interaction/spec-cascade.test.ts` (`parallel calls share one run`); `tests/e2e/spec-cascade.test.ts` |
| Read-only forge skips the cascade | `tests/interaction/spec-cascade.test.ts`; `tests/e2e/spec-cascade.test.ts` |

### approver-adapters

| Scenario | Test |
|---|---|
| Tool has no answer parameter | `tests/tools/no-answer-params.test.ts` (unchanged) |
| Relayed approval refused, Amendment request kind, Decide request kind, Recommendation is not an answer | existing `tests/interaction/in-session.test.ts` and `tests/interaction/forge.test.ts` (kept green) |
| Question request lists no requirements | `tests/tools/spec-question.test.ts` (snapshot without `requirements`); `tests/interaction/forge-text.test.ts` (no `--changes`) |
| Approve in the TUI, Unavailable without UI, Answer later in session, Empty required text in the fallback, Dialog in the TUI, Select chain in RPC mode, Fallback when the dialog draws nothing, Same answer on both paths | existing `tests/interaction/in-session.test.ts` and `tests/tools/spec-question.test.ts` (kept green) |
| Question candidate picked in session | `tests/interaction/in-session.test.ts` |
| Own answer instead of a candidate | `tests/interaction/in-session.test.ts` |
| Approve by a writer, Command without write access ignored, Command before the request ignored | existing `tests/interaction/forge.test.ts` |
| Answer that changes a requirement | `tests/interaction/commands.test.ts`; `tests/interaction/forge.test.ts` |
| Answer with a class | `tests/interaction/commands.test.ts`; `tests/interaction/forge.test.ts` |
| Class command applied once, Class command recorded across sessions, Class command already matching, Class rewrite conflict retried | existing `tests/interaction/forge.test.ts` and `tests/interaction/poll.test.ts` |
| Approve through Review, Review shows the answer before it is sent, No unit tab without overridable units | existing `tests/interaction/dialog/*.test.ts` |
| Answer later skips Review, Esc cancels the dialog, Esc in the note editor | existing `tests/interaction/dialog/state.test.ts` and `tests/interaction/dialog/keys.test.ts` |
| Question answered in the dialog | `tests/interaction/dialog/state.test.ts`; `tests/interaction/dialog/view.test.ts` |
| Own answer typed in the dialog | `tests/interaction/dialog/state.test.ts` |
| Empty own answer blocked | `tests/interaction/dialog/state.test.ts` |
| Question without candidates | existing `tests/interaction/dialog/model.test.ts` |

### unit-planning

| Scenario | Test |
|---|---|
| Second plan gate re-locks | `tests/interaction/complete.test.ts` (plan gate also carries `requirements`) |
| Plan gate with a stale unit, Identical amendment clears a stale unit | existing `tests/engine/locks.test.ts` and `tests/tools/unit-amend*` tests |
| Stale before the first lock | `tests/e2e/gates-flow.test.ts` (seeded `stale`) |
| Re-approval after a missing baseline | `tests/e2e/spec-cascade.test.ts` |

### unit-evidence

| Scenario | Test |
|---|---|
| Not in a per-unit phase, Receipted unit outside a per-unit phase | `tests/tools/unit-finish.test.ts`; `tests/evidence/refusals.test.ts` |
| Green at post, Not green at post, Not started, Open lane refuses finish, Crash between receipt and tick, Digest changed since start, Unresolved blocking finding, Review required but not run, Lane review accepted after merge, Incomplete review does not count, Receipted unit with a new blocking finding, Rebuild is not re-ticked | existing `tests/tools/unit-finish.test.ts` and review tests (kept green) |

### phase-gates

| Scenario | Test |
|---|---|
| Old approval not reused after a cascade | `tests/e2e/spec-cascade.test.ts` (after "Spec edit sends the change back", the next step says ready for the `define` gate) |
| Define approved, Superseded result does not fall back, Failed move retried, Ship approved, Changes requested, Dismissed | existing `tests/engine/next-step.test.ts` and `tests/e2e/gates-flow.test.ts` (kept green) |
