# Apply Receipt

> Generated at the end of the apply phase to mark code-implementation
> complete and provide verify with the state it needs.
> Overwritten on each apply iteration; iteration counter grows.

**Change**: `gates-and-decisions`
**Iteration**: `1`
**Applied at**: `2026-11-16 04:30`
**Executor**: `subagent-driven-development`. The implementer seat was the `implementer` agent; the task reviewer, final whole-branch reviewer and re-reviewer seats were the `code-reviewer` agent. Tasks 1–3 ran as parallel lanes; Tasks 4–10 ran sequentially.

---

## Workspace

- **Worktree path**: `/Users/naicoi/Projects/oss/pi-livespec.gates-and-decisions`
- **Worktree branch**: `gates-and-decisions`
- **Feature branch**: `ls-05`
- **Base branch**: `main`

---

## Commits

- **Range**: `667c3d6..HEAD` on `gates-and-decisions`. Before this receipt the head was `573fe3b`; the receipt commit follows it.
- **Count**: 56 commits before the receipt, including 3 lane merge commits.

Verification at `573fe3b`: `bun run typecheck` is clean, and `bun run test` passes 112 files with 1539 tests. The baseline before apply was 84 files with 1154 tests.

---

## Tasks

- **Completed**: 38 of 39 checkboxes in tasks.md are ticked.
- **Remaining**: `10.4`, the manual smoke.
  - The automated part of 10.4 is done: typecheck and test counts are recorded in `smoke.md`.
  - The manual part is still pending: a TUI `spec_gate` approval, and a forge `/livespec approve` from a second writer account on a scratch GitHub repository.
  - This session had no scratch repository, network forge or interactive TUI.
  - The fallback evidence is `tests/e2e/gates-flow.test.ts` › `full gate flow over a memory forge`. It runs on an in-memory forge, so it is not real end-to-end verification.

---

## Contract deviations

Contract changes made during apply. The public ones are additive only.

- `AmendSnapshot.records`: typed `unknown[]` in Task 2, because Task 1 ran in parallel. Task 4 narrowed it to `DecisionRecord[]` as planned.
- `decide` `ask` callback (Task 1): uses local answer types that are structurally compatible with `Answered`/`Pending`.
- `GateResult` (public, additive):
  - `waivers: string[]`, added in Task 7: a gate approved with waivers advances, and next step skips the waived failing checks.
  - `notes: string`, added in the final fix wave: the human's notes appear in the next step for `changes_requested` and `dismissed`.
  - Both are recorded in the `LockState` row of `plan.md`.
- `validApproval(r)` (Task 4, internal): a new helper and the only test for "this gate result counts as an approval". It never falls back to an older result. In the fix wave its parameter narrowed to `Pick<GateResult, "outcome" | "superseded">`.
- `CompletionCtx.root` (Task 6, internal): answer validation reruns the phase checks.
- Forge adapter internals (Task 6 and its fix rounds):
  - `createForgeApprover(forge, issue, { available })`;
  - `matchCommands(..., { marked })`, where `marked` is required and command targets are computed from position in the thread;
  - `readPermissions`/`commandAuthors` moved to `forge-permissions.ts`;
  - new `DuplicateRequestError`;
  - `finishApplying` returns `{ finished, errors }`;
  - `Session.pollInFlight`, so polls in one session never run at the same time.
- `SnapshotDeps.iterationCap` (Task 4, internal) and `counters.change_iterations`: the count always comes from `stale` comments; a stored counter comment is ignored.
- `SendOptions` in `src/tools/request-flow.ts` (Tasks 8–9, internal): a shared request-sending helper used by `spec_gate`, `unit_amend`, `spec_question` and `spec_stuck`, with an optional `deferred`. The in-session-only waive precheck was removed in the fix wave, because one shared waive rule (`waive-rule.ts`) now covers every adapter.
- Extra modules beyond the plan's file lists: `complete-effects.ts`, `complete-overrides.ts`, `complete-validate.ts`, `amend-body.ts`, `forge-match.ts`, `forge-permissions.ts`, `display-ids.ts`, `session-ctx.ts`, `waive-rule.ts`, `request-flow.ts`, `src/decide/rules/schema-util.ts`.

---

## Lanes

| Task | Lane branch | Lane range | Review | Merge commit |
|---|---|---|---|---|
| 1 | `gates-and-decisions--task-1` | `667c3d6..17c6e78` | approved after 1 fix round | `751367e` |
| 2 | `gates-and-decisions--task-2` | `667c3d6..4f6764f` | approved after 2 fix rounds | `53c7727` |
| 3 | `gates-and-decisions--task-3` | `667c3d6..8e71b17` | approved after 2 fix rounds | `37862e0` |
| 4 | sequential | `5bb42eb..1f9137e` | approved after 1 fix round | — |
| 5 | sequential | `ff41565..1b02fcc` | approved after 2 fix rounds | — |
| 6 | sequential | `e6a38ef..108d081` | approved after 2 fix rounds (fresh implementer from round 1) | — |
| 7 | sequential | `d5e583d..91a72a6` | approved after 1 fix round | — |
| 8 | sequential | `10d4ecd..e55fa68` | approved after 1 fix round | — |
| 9 | sequential | `59bc056..27e9b42` | approved after 1 fix round | — |
| 10 | sequential | `dee7507..482e94e` | approved | — |
| final | sequential (one fix wave) | `7e9931a..573fe3b` | final review "with fixes" → fix wave → re-review approved | — |

---

## Open items for verify and the user

- **10.4 manual smoke:** pending, as described under Tasks.
- **Design question for the user (final review I3):**
  - A forge approval that is read while the local working tree is dirty gets recorded as `superseded`, and the human has to approve again.
  - This follows the spec as written (phase-gates "Gate comment", design D2).
  - The alternative is to keep the request pending until the tree is clean. That would change the spec.
- **Parked minors** (follow-up or LS-06):
  - the superseded gate reason is wrapped in `untrusted` twice;
  - unused fields and methods: `GateSnapshot.digests`, `LockState.stalePhases`, `ApproverUI.confirm`, `forge.poll`;
  - `/livespec class` is applied again on each poll while the request is pending;
  - the tags config is normalised once per tag lookup.
- **Known gaps documented in `docs/architecture.md`:**
  - command comments posted by the plugin's own login through bash (LS-06 guard);
  - a `flow.yaml` override can lower a gate (LS-06 guard);
  - polls in two different sessions or machines can complete the same answer twice.

---

## Next step

Run `/opsx-verify`.
