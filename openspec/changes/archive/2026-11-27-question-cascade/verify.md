# Verification Report

**Change**: `question-cascade`
**Verified at**: `2026-11-27 17:45` (local)
**Iteration**: `1`
**Verifier**: parent session (fresh typecheck and test run, spot checks), with independent evidence from `superspec.verifier` (agent `5aa16972-91a8-4bb`) collected in this invocation

---

## 1. Structural Validation (`openspec validate <change>`)

- [x] The command passes for this change

**Result**:

```text
$ openspec validate question-cascade   (cwd: worktree, exit 0)
Change 'question-cascade' is valid
5 warnings: questions-and-stuck/spec.md, ADDED requirements "Requirement baseline",
"Integration-branch exclusion", "Spec-diff requirement cascade", "Locks without
requirement digests", "Cascade triggers": requirement text is longer than 500 characters.
```

---

## 2. Task Completion (`tasks.md`)

- [x] Every box is ticked

Evidence:
- `grep -c '\[ \]' tasks.md` returns 0 and `grep -c '\[x\]' tasks.md` returns 19.
- `openspec instructions apply --change question-cascade --json | jq .progress` returns `{"total":19,"complete":19,"remaining":0}`.

| Open task | Reason | Blocks archive? |
|---|---|---|
| — | — | — |

---

## 3. Requirement Evidence

- [x] ADDED / MODIFIED: implementation evidence (file / line)
- [x] REMOVED: evidence the baseline behavior is gone
- [x] RENAMED: not applicable (none)

| Requirement | Operation | Status | Evidence (file:line) or reason |
|---|---|---|---|
| questions-and-stuck / Requirement baseline | ADDED | Pass | `src/engine/requirement-diff.ts:15,21,47,58,76,82`; `src/tools/spec-gate.ts:87,99-100,126,143,154,166-167`; `src/interaction/approver.ts:53-55`; `src/interaction/complete-gate.ts:51-52,103-104`; `src/engine/locks.ts:33,100-103,157`; `src/initiatives/sync.ts:19,107-109` (shared detector) |
| questions-and-stuck / Integration-branch exclusion | ADDED | Pass | `src/interaction/spec-cascade-plan.ts:111` (`excludedIds`); `src/interaction/spec-cascade.ts:42-54` (`integrationRef`: fetch, merge-base, `Base` fallback) |
| questions-and-stuck / Spec-diff requirement cascade | ADDED | Pass | `src/interaction/spec-cascade-plan.ts:94,165,190,197`; `src/interaction/spec-cascade.ts:105,112,127,134,147,185` |
| questions-and-stuck / Locks without requirement digests | ADDED | Pass | `src/interaction/spec-cascade-plan.ts:81,144`; `src/interaction/spec-cascade.ts:58-62`; `src/engine/git.ts:91,346` |
| questions-and-stuck / Cascade triggers | ADDED | Pass | `src/hooks/session.ts:119,554`; `src/commands/next.ts:12`; `src/tools/spec-gate.ts:267`; `src/tools/unit-finish.ts:242`; `src/tools/unit-tool.ts:27,75-80`; `src/tools/lane-merge.ts:112` (passes no `before`) |
| questions-and-stuck / Question answers | MODIFIED | Pass | `src/interaction/complete-question.ts:21` (only `applyQuestion`, no cascade) |
| questions-and-stuck / Requirement cascade | REMOVED | Pass | Baseline (`openspec/specs/questions-and-stuck/spec.md` "Requirement cascade"): an answer naming a changed requirement cascades. Running `grep -rnE 'changesRequirement\|changes_requirement\|askChangedRequirement\|--changes\|pickRequirement' src` matches only `src/interaction/commands.ts:24-25`, which is the refusal constant and message. `grep -n cascade src/interaction/complete-question.ts` finds no match. |
| approver-adapters / Approver contract, In-session adapter, Forge command comments, In-session dialog, Dialog exits without Review, Dialog questions | MODIFIED | Pass | `src/interaction/commands.ts:24-25,58` (`--changes` refused); `src/interaction/approver.ts` (`Answered` has no `changesRequirement`); `src/interaction/dialog/*` has no requirement step (grep finds no `pickRequirement` or `requirements`) |
| unit-planning / Re-planning after the lock | MODIFIED | Pass | `src/engine/locks.ts` (`LockState.baseline` from the lock gate; the plan gate carries `requirements`); `src/interaction/complete-gate.ts:103-104` |
| unit-evidence / Unit finish tool | MODIFIED | Pass | `src/evidence/refusals.ts:54-59,86,132,134,136`; `src/tools/unit-finish.ts:61` (phase re-read before the tick), `:229` (phase check first in `precheck`) |
| phase-gates / Gate outcomes | MODIFIED | Pass | The behaviour is unchanged apart from the cascade source: `src/interaction/spec-cascade.ts:127` (move to `define`); gate invalidation by `stale` in `src/engine/locks.ts` |

---

## 4. Scenario Coverage

- [x] Every scenario maps to a test
- [x] The project test command was run fresh in this step

**Test command**: `bun run typecheck && bun run test` (cwd: worktree, HEAD `287d867`, host load average about 23)
**Result**:
- `bun run typecheck`: exit 0.
- `bun run test`: exit 0. Test Files: 255 passed (255). Tests: 3981 passed (3981). Duration: 224.65 s.

Scenarios under the REMOVED requirement are skipped. The full map is the plan.md "Scenario → test" table; the verifier confirmed by grep that each test file and name exists. Key rows:

| Scenario | Test |
|---|---|
| Spec edit sends the change back; Edit no done unit covers; Same edit cascades once; Further edit of the same requirement; Edit reverted after a cascade; Removed requirement cascades once; Second edit while in define; Retried cascade counts once; Rebased branch on a fresh clone; Edit after a rebase; Capability covered after the lock; Edit merged by change_sync ignored; Hand merge of the integration branch ignored; Conflict resolved by combining both sides; Own edit reverted while main never touched it; Baseline commit missing; Missing baseline handled once; Baseline commit missing in define; Parallel triggers run once; Read-only forge skips the cascade; Re-approval after a missing baseline; Old approval not reused after a cascade | `tests/e2e/spec-cascade.test.ts:108-477`, one test per scenario name; planner and runner cases in `tests/interaction/spec-cascade-plan.test.ts` and `tests/interaction/spec-cascade.test.ts` |
| Whitespace and moved lines ignored | `tests/engine/requirement-diff.test.ts`; `tests/e2e/spec-cascade.test.ts` |
| Edit before the lock | `tests/interaction/spec-cascade-plan.test.ts` (`no lock → none`); `tests/e2e/spec-cascade.test.ts` |
| Plan gate records the digests | `tests/tools/spec-gate.test.ts:588`; `tests/interaction/complete.test.ts:169` |
| Old lock with its commit present | `tests/interaction/spec-cascade.test.ts` (legacy lock with commit present); `tests/engine/git.test.ts` (`hasCommit`) |
| Answer written back; Answer in build changes nothing else; Human reclassifies | `tests/interaction/complete.test.ts:375`; `tests/tools/spec-question.test.ts:135,121`; `tests/e2e/spec-cascade.test.ts` |
| Answer that changes a requirement (refusal); Answer with a class | `tests/interaction/commands.test.ts:38,42,50`; `tests/interaction/forge.test.ts:154` |
| Question candidate picked in session; Own answer instead of a candidate | `tests/interaction/in-session.test.ts:427,436` |
| Question answered in the dialog; Own answer typed in the dialog; Empty own answer blocked; Question without candidates | `tests/interaction/dialog/state.test.ts:154,158`; `dialog/view.test.ts:341`; `dialog/model.test.ts:96,100` |
| Question request lists no requirements | `tests/tools/spec-question.test.ts:100` (snapshot has no `requirements`); `tests/interaction/dialog/model.test.ts:96`; `tests/interaction/forge-text.test.ts` (no `--changes`) |
| Not in a per-unit phase; Receipted unit outside a per-unit phase | `tests/tools/unit-finish.test.ts:91,101`; `tests/evidence/refusals.test.ts:171-173` |
| Open lane refuses finish (existing) | `tests/tools/lane-tools.test.ts:291,319` |
| Remaining existing scenarios (approver-adapters, unit-evidence, unit-planning, phase-gates) | Existing tests are kept green: `tests/interaction/{in-session,forge,poll}.test.ts`, `tests/interaction/dialog/*.test.ts`, `tests/tools/{unit-finish,no-answer-params,spec-gate}.test.ts`, `tests/engine/{locks,gates,next-step}.test.ts`, `tests/e2e/gates-flow.test.ts`; the full run above is green |

Some scenarios in the table (for example "Approve through Review", "No unit tab without overridable units", "Answer later skips Review") are covered by tests with different names, `dialog/keys.test.ts:121` and `dialog/state.test.ts:86`. See Issues.

---

## 5. Design and Contract Coherence (warning only)

- [x] Decisions in design.md match the code, except one doc-only drift (below)
- [x] Contracts in plan.md, with the Contract deviations recorded in apply.md, match the code

Per plan.md Contracts entry, compared read-only:
- **Matched:**
  - `requirementContent`, `requirementDigests` (including the duplicate-id throw at `src/engine/requirement-diff.ts:37`), `changedIds`, `REMOVED_DIGEST`, `capabilityOf`, `coversId`, `requirementScope`, `RequirementRecord` and `requirementRecord`, in `src/engine/requirement-diff.ts`.
  - `declaredCapabilities`, in `src/core/change.ts`.
  - `Git.hasCommit`, in `src/engine/git.ts:346`.
  - `GateSnapshot`, `GateCommentInput`, `selfGateComment`, `gateRequest` (scope from the bound body) and `LockState.baseline` (pair-only parse), in `approver.ts`, `complete-gate.ts`, `spec-gate.ts` and `locks.ts`.
  - `isSpecCascade`, `isBaselineStale`, `CascadeInput`, `acknowledgedDigests`, `excludedIds` (requires `reference[id]` to be defined), `SpecCascadePlan`, `planSpecCascade` (with `failedClosed`) and `needsMoveBack`, in `src/interaction/spec-cascade-plan.ts`.
  - `integrationRef` (pinned head, body `Base`) and `runSpecCascade` (single-flight, branch guard, pinned HEAD), in `src/interaction/spec-cascade.ts`.
  - `lockedEvidenceCall` options object, in `src/tools/unit-tool.ts:27,75`.
  - Removed contracts: `Answered.changesRequirement`, `QuestionSnapshot.requirements`, `ApprovalRequest.question.requirements` and the dialog requirement step are all gone from `src/`.
  - `/livespec answer` grammar and removal message, in `src/interaction/commands.ts:24-25,58`.
  - `unit_finish` refusal, in `src/evidence/refusals.ts` and `src/tools/unit-finish.ts:61,229`.
- **Matched (apply.md deviations):** all ten entries have their code counterpart at the locations above.
- **Not verified (forge record formats, which can be compared only through tests):**
  - the spec-cascade `stale` data and `spec.<12 hex>` id: `tests/interaction/spec-cascade.test.ts:306`, `spec-cascade-plan.test.ts:277`;
  - the legacy `baseline.<sha12>` data: `spec-cascade-plan.test.ts:297`;
  - the plan `gate` comment `requirements` and `requirement_scope`: `tests/interaction/complete.test.ts:169`;
  - the `question` comment without `changes_requirement`: `tests/interaction/complete.test.ts:375`.

  The tests passed in the fresh run, but there is no code-level schema to compare against.

**Drift warnings** (non-blocking):
- design.md D2 describes `legacy` as a third digest map read by `readCascadeInput` (`design.md:38`). The code and the plan.md `CascadeInput` row fold the legacy digests into `baseline` (`src/interaction/spec-cascade.ts:58`).

---

## 6. Clean Tree and Commit Range

- [x] Working tree is clean (`git status --porcelain | wc -l` returns 0 before this receipt)

**Commit range**: `cade697..287d867` (20 commits: 19 implementation and review-fix commits plus the apply receipt). This receipt is committed on top.

---

## Overall Decision

- [ ] PASS
- [x] PASS_WITH_WARNINGS: no CRITICAL issues and the fresh typecheck and test run are green. Warnings remain (below), and check 5 records some forge record formats as not verified at code level (covered by tests).
- [ ] FAIL

### Issues

**CRITICAL**: none.

**WARNING**
1. `design.md:38` (D2) describes a separate `legacy` digest map, but the code folds it into `CascadeInput.baseline` (`src/interaction/spec-cascade.ts:58`). Reword D2 to say "`baseline`: the gate record, else the legacy digests at `head_sha` (D6), else undefined", matching the plan.md `CascadeInput` row.
2. `CHANGELOG.md` does not mention the behaviour change from the final fix wave: a spec whose requirement names collide after whitespace normalization now fails `change_sync`, the plan gate record and the cascade with a recorded error, instead of the last requirement silently winning. Add one line under Unreleased › Changed.
3. Pre-existing test isolation defect, outside this change: `tests/evidence/red-on-base.test.ts` ("Green on base refuses the plan gate") and `tests/evidence/worktree.test.ts` both assert that no `livespec-verify-*` directory exists in the shared OS tmpdir. They fail when run together or under load, and pass alone. They passed in this fresh run. Open a follow-up issue to use a per-test tmpdir.

**SUGGESTION**
1. `openspec/changes/question-cascade/plan.md`, "Scenario → test": some rows name tests by the scenario title while the actual tests have other names ("Approve through Review" → `dialog/keys.test.ts:121`; "No unit tab without overridable units" → `dialog/state.test.ts:86`; "Answer later skips Review" → `dialog/host.test.ts:123`; "Question request lists no requirements" → `spec-question.test.ts:100`). Point the rows at the real test names, or rename the tests after their scenarios.
2. `specs/questions-and-stuck/spec.md`: the five ADDED requirements exceed the 500-character advisory length. Move examples into scenarios, or leave it, since the validator passes.
3. Open the follow-up issue parked by the final review (FR2): after a cascade, an identical amendment and re-lock lets a receipt from before the cascade re-tick a unit without rerunning `Verify`. This applies to every stale source.

**Next step**: run `/opsx-continue` with the worktree as the working directory to create the finalize artifact, then `/opsx-archive`.
