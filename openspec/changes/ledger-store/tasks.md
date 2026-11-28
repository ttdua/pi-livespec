## 1. Record identity refactor (`commentId` → `ref`, `source`)

Blocked by: none

- [x] 1.1 Rename `MarkedComment.commentId` to `ref` and add `source: "forge" | "ledger"` and `createdAt` in `src/forge/markers.ts`; `filterMarked` sets `source: "forge"`
- [x] 1.2 Update every reader and writer of `MarkedComment.commentId` in `src/` and `tests/` mechanically (gate `commentId` fields in `src/engine/locks.ts` keep their name); no behaviour change
- [x] 1.3 Pin the spec-cascade `stale` id for a fixed lock before the rename (`tests/interaction/spec-cascade-plan.test.ts`) so the rename provably keeps it
- [x] 1.4 `bun run typecheck` and `bun run test` green

## 2. Ledger core: entries, store, commit and read

Blocked by: none

- [x] 2.1 `src/core/record-kinds.ts`: `LEDGER_KINDS` (neutral module); `src/ledger/entry.ts`: entry type, file of each kind, `newRef`, validation, `entryVersion` (sorted-key JSON without `seq`); unit tests
- [x] 2.2 `src/ledger/store.ts`: `readTree(commit)` and `readLedger(n)` (ls-tree + `cat-file blob`, schema check, skip-with-warning rules of "Invalid ledger content", cache by tip SHA)
- [x] 2.3 `commitEntries(n, base, entries[])` with temp file blobs and a temp `GIT_INDEX_FILE` tree (no stdin needed), `appendEntry` with `update-ref` CAS and 5 retries, committer fallback, refusal of other kinds
- [x] 2.4 Tests against real temp repos: first append, two worktrees appending at once, dirty tree untouched, no identity, corrupt line, unknown schema, duplicate ref, kind in the wrong file

## 3. Guarded ledger git paths and the bash guard rule

Blocked by: none

- [x] 3.1 `src/guard/push.ts`: `ledgerFetch`, `ledgerPush`, `ledgerDelete` with the positive-integer check and exact refspecs; tests for refspecs and refusals
- [x] 3.2 Guard rule: block agent git commands naming `refs/livespec` or `livespec-origin` except listed read subcommands; block `update-ref --stdin` and wildcard destination refspecs outside `refs/remotes/`
- [x] 3.3 Push-callers scan: only `src/ledger/` uses the ledger operations, and the scan's caller allow-list admits `src/ledger/sync.ts`

## 4. Ledger sync, fetch before use, retention plumbing

Blocked by: 2, 3

- [x] 4.1 `src/ledger/sync.ts`: fetch into the tracking ref (clear it when the remote ref is absent), fast-forward, replay through `commitEntries`, push with 3 restarts; results `synced`/`pending`/`error`
- [x] 4.2 `pending(n)` from local refs only
- [x] 4.3 `Ledger` facade: `read`, `append`, `ensureFetched` (per session, offline rules), `sync`, `remove` (maps `deleted`/`gone`/`moved`/failure; the guarded calls live in `sync.ts`), exposes `background`, a promise covering every background sync started
- [x] 4.4 Tests with a bare remote and two clones for every ledger-store sync, fetch-before-use and retention scenario

## 5. Change state and reader seam

Blocked by: 1, 4

- [x] 5.1 `src/ledger/merge.ts`: `mergeRecords` (anchors, `createdAt <= at` fallback also for absent `after`, before-all, file-order ties), `matchesRef`, `lastForgeRef`; unit tests
- [x] 5.2 `readOwnRecords(forge, ledger, n)`: own marked comments merged with entries, the one seam every reader of own records uses
- [x] 5.3 Snapshot reads through the seam with its cached comments; `Session.refresh({ fetch })` fetches by default and is threaded to `buildCardInput`/`readChangeSnapshot`; only the context hook and session start pass `fetch: false`; `prepareWrite` refuses on `unknown-offline` before any other work; ledger warnings (pending, may be out of date, invalid content); latest counter by merged position
- [x] 5.4 Direct readers switch to the seam: `interaction/poll.ts`, `tools/decide-ask.ts`, `interaction/forge.ts` and `tools/approver-for.ts`, `evidence/wip.ts` (`WorkInProgressFn` gains the ledger; callers `hooks/session.ts`, `commands/deps.ts`), `ship/feedback-poll.ts`
- [x] 5.5 `Session.ledger`, `WriteContext.ledger`, `CompletionCtx.ledger`, `afterLedgerWrite`; background session-start sync whose promise the test harness awaits
- [x] 5.6 Test helpers: `ofKind` reads the merged list, `h.seed` appends ledger kinds to the ledger, `ledgerRecord(input)` builds a `MarkedComment` for pure-reader tests; `originRefs` assertions meant as "no branch push" ignore `refs/livespec/`

## 6. Evidence and planning writers

Blocked by: 5

- [ ] 6.1 Builders `startComment`, `receiptComment` (`src/evidence/records.ts`) and `decisionComment` (`src/decide/records.ts`) return `AppendInput`; every caller of `decisionComment` outside this group (`review/stages.ts`, `interaction/complete-*.ts`) keeps compiling through a temporary `decisionBody(input)` that wraps it as a marked comment until groups 7 and 8 move them; `setCounter` appends
- [ ] 6.2 `unit_start` appends `unit-start`; `unit_finish` appends the receipt before the tick and `progress` decisions, names receipts and attempts as `ledger:<issue>/<ref>`, receipt `start` is the start entry ref
- [ ] 6.3 `plan-units-steps.ts` appends decisions before the body write
- [ ] 6.4 Tests: unit-evidence, decision-seam, second machine `unit_start`, `unit_start` refusal with an unknown ledger offline (`tests/tools/unit-*.test.ts`, `tests/tools/plan-units.test.ts`, `tests/tools/spec-gate.test.ts`, `tests/tools/change-split.test.ts`, `tests/engine/gates.test.ts`, `tests/ship/context.test.ts`, `tests/e2e/spec-cascade.test.ts`, `tests/evidence/red-on-base.test.ts`, `tests/evidence/wip.test.ts`, `tests/evidence/progress-rule.test.ts`, `tests/engine/checks.test.ts`, `tests/engine/snapshot.test.ts`, `tests/review/effects.test.ts`, `tests/subagents/sources.test.ts`, `tests/subagents/freshness.test.ts`, `tests/e2e/build-flow.test.ts`)

## 7. Subagent and review writers

Blocked by: 6

- [ ] 7.1 Builders `dispatchComment`, `findingSummaryComment`, `rebuttalComment`, `aggregateComment` return `AppendInput`; dispatch deps `record(input)` replaces `post` for these kinds in `tools/subagent-request.ts` (`recordDeps`), `tools/lane-open.ts`, `tools/lane-merge.ts`, `tools/subagent-dispatch.ts`, `audit/confirm.ts` (no-op)
- [ ] 7.2 `subagents/dispatch.ts` (QUESTION, mismatch), `run-record.ts`, `resume.ts` (RETRY), `lane-ops.ts`, `subagent-answer.ts` (ANSWERED), `subagent-record.ts`, `finding-rebut.ts` (write side only) append
- [ ] 7.3 `review/stages.ts` appends `tags.review`, `finding-scope` and the aggregate (`reviews` as entry refs); `review-run` stays a comment
- [ ] 7.4 Tests: subagent-dispatch, review-findings, finding-routing, forge-cache read-only append (`tests/subagents/*.test.ts`, `tests/tools/subagent-*.test.ts`, `tests/review/*.test.ts`, `tests/subagents/packet.test.ts`, `tests/subagents/freshness.test.ts`, `tests/e2e/review-flow.test.ts`, `tests/e2e/subagent-build.test.ts`)

## 8. Completion engine writers

Blocked by: 7

- [ ] 8.1 `ApplyFn` returns `ResultRecord` (`{ comment } | { entry }`); the dispatcher in `complete.ts` posts or appends it last; `appendRecord(run, input)` in `complete-effects.ts`
- [ ] 8.2 `complete-decide.ts`, `complete-overrides.ts`, `complete-amend.ts` append decisions; `session-ctx.ts` and the poll pass the ledger; a `decide:` request is completed by its `decision` entry (`requests.ts`); delete the temporary `decisionBody`
- [ ] 8.3 Tests: approver-adapters ledger scenarios, durable-doc-checks "Answer recorded" and "Other refusal asks nothing", poll does not re-apply a completed decide (`tests/interaction/complete.test.ts`, `tests/interaction/poll.test.ts`, `tests/tools/decide-ask.test.ts`, `tests/tools/spec-gate-behavior.test.ts`, `tests/docs/behavior-change.test.ts`)

## 9. Markers stop accepting ledger kinds

Blocked by: 6, 7, 8

- [ ] 9.1 `src/forge/markers.ts`: the six kinds leave `CORE_KINDS`, `registerKind`/`writeMarked` refuse them, `filterMarked` drops own comments of those kinds with one warning per kind; remove module-load `registerKind` calls for `unit-start` and `dispatch`
- [ ] 9.2 `tests/forge/markers.test.ts` (example kind `stale`, ledger kind refused, old receipt comment); forge contract and adapter tests use forge kinds as examples (`tests/forge/contract.ts`, `github.test.ts`, `gitea.test.ts`); remaining seeds of ledger kinds via `writeMarked` move to `h.seed`/`ledgerRecord` (`tests/tools/change-sync.test.ts`, `forge-read.test.ts`, `spec-gate.test.ts`, `decide-ask.test.ts`, `tests/review/round.test.ts`, `tests/subagents/helpers.ts`, `tests/engine/comments-cache.test.ts`, `tests/engine/counters.test.ts`, `tests/subagents/sources.test.ts`, `tests/subagents/packet.test.ts`); e2e flows assert no comment of the six kinds and the ledger holds them

## 10. Public references and packet sources

Blocked by: 9

- [ ] 10.1 `sources-records.ts` cites ledger records as `ledger:<issue>/<ref>` with `entryVersion`; `records:decisions` names entries by that id
- [ ] 10.2 `finding_rebut` parameter `ref` (lookup by `ref` or `from`, refusal message); verifier reference `<aggregateRef>:<index>` (`subagent-target.ts`, `build-loop.ts`, `review/status.ts`, `review/effects.ts`); question key `finding:<aggregateRef>:<index>`
- [ ] 10.3 Freshness treats ledger records as own and compares `entryVersion`
- [ ] 10.4 Tests: subagent-packets ledger scenarios, rebuttal scenarios, "Question raised once" (`tests/review/effects.test.ts`)

## 11. Ship and close

Blocked by: 4, 9

- [ ] 11.1 `change_ship` syncs after its refusal checks and refuses unless `synced`
- [ ] 11.2 Config `ledger.retain` (project, boolean, default `true`, warning otherwise) and doctor's config listing
- [ ] 11.3 `change_close` removes the ledger with `retain: false` after closing the issue; skips with no local ref; names a failed remote delete
- [ ] 11.4 Tests: ship-phase and change-close ledger scenarios, init-and-doctor config scenarios

## 12. Docs

Blocked by: 10, 11

- [ ] 12.1 ADR `docs/decisions/0008-machine-ledger.md` refining 0002 and 0007; index and 0002 status line
- [ ] 12.2 `docs/architecture.md`, `docs/glossary.md`, README.md and README.vi.md (`ledger.retain`), CHANGELOG Unreleased with breaking notes
