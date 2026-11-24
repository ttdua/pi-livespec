# Task 7 report — Audit command, scout, report and triage

**Status:** DONE · **Commit:** `bccfffa` (`feat(audit): /livespec audit command, scout confirmation, report and triage`) on `durable-docs-audit`, base `90fae0a`.

## What

| Unit | File | Responsibility |
|---|---|---|
| `Git.firstParentCommits` | `src/engine/git.ts` | `git log --first-parent --reverse --format=%H%x00%s [--since] <after>..<commit> \| <commit>` |
| `AuditState` (type only) | `src/audit/state.ts` | `{ cursor?, fixCursor?, auditedCommit?, pending }` |
| `confirmItems` | `src/audit/confirm.ts` | heuristic items (`scenario-untested`, `removed-reference`) → one `scout` via `runDispatch` in a `withTempWorktree` at the audited SHA; packet = `protocolText()` + task listing key/evidence + capability spec text, all `untrusted()`, + `Audited commit: <sha>`; hash = sha256(text), `skillPaths: []`; `post` sink → no `dispatch` comment; role `scout`, `change: "audit"`, difficulty `low`, attempt/round 1, failedAttempts/needsContext 0. Refuted → dropped + listed; confirmed → `confirmed: true`; any non-`result` outcome, missing verdict, no executor, worktree failure → `confirmed: false` + note (never suggests inline). |
| `renderReport`, `deliverReport`, `reportComment`, `registerKind("drift-report")` | `src/audit/report.ts` | Major then Minor, `- [sev] key — evidence → route (unconfirmed; re-triaged by X from Y)`, refuted, ignored, unmatched, notes, "Routes are suggestions; the audit changed nothing."; marker id `drift-report.<sha12>.<base36 ms>`, data `{ commit, items, refuted, ignored }` + rendered text. Posts only with target AND forge AND writable; otherwise prints with reason. |
| `applyTriage` | `src/audit/triage.ts` | first-line `/livespec triage <key> major\|minor\|ignore`; permission read once per author through the injected `canWrite`; latest command per key wins; unmatched keys listed. |
| `runAudit`, `AuditDeps`, `AuditOutcome` | `src/commands/audit.ts` | pipeline `snapshotOf → repoViewAt → detect → confirmItems → classify → triage → deliverReport`, each a named step; fetch failure → local `origin/<integration>` with `refreshed: false` + error; no ref / no integration → `ok: false`, nothing posted; `declared-none` skipped with note when forge missing or throws (`fixesRan: false`); default target = first `initiative` in `state.pending`. |
| `auditReply` | `src/commands/subcommands.ts` | session → `AuditDeps` (git, root, `integrationBranch`, forge, `forgeWritable(session)` — same predicate as forge requests, includes `accountBlock`, executor via `findExecutor`, pi events, `exclusionsOf`, pack `decisions["drift-severity"]`, `state: { pending: [] }`); parses `[#T]`, bad arg → usage. |
| Routing | `src/extension.ts` | `case "audit"`, `USAGE` gains `| audit [#T]`, description lists `audit`; pi's `events` passed through (`eventsOf`, no-op bus fallback). |

Triage permission: reuses the forge-command predicate (`write`/`admin` writers, a failed `getPermission` = no access, as `readPermissions` does).

## Tests (TDD)

- **Declarations first:** stubs for all five modules + `firstParentCommits` → `bun run typecheck` exit 0.
- **RED:** git 3/3 fail; confirm 7/7 fail; report+triage 12 fail; command+extension 12 fail (all "not implemented"/usage mismatch).
- **GREEN:** after each implementation; extra RED→GREEN cycles for: failed post still prints (report), worktree failure → unconfirmed (confirm), mismatch note does not mention inline (confirm).
- Files: `tests/engine/git.test.ts` (firstParentCommits: after/side-branch/merge, since 31 vs 29 days, empty), `tests/audit/confirm.test.ts` (Renamed test refuted, No executor, Launch mismatch, Scout sees the audited snapshot, Audit scout launch, Audit scout writes no dispatch record, worktree failure, no heuristic item), `tests/audit/report.test.ts` (render order/marks/sections/disclaimer, not refreshed, untrusted unmatched keys, Posted on the initiative, No initiative, read-only/no forge, failed post, Marker kind registered), `tests/audit/triage.test.ts` (Minor raised to major, Major lowered to minor, Reader without write access, ignore + latest wins, unmatched key listed, malformed/other comments), `tests/commands/audit.test.ts` (Read-only on files, Integration snapshot not the feature branch, Fetch fails with a local ref, No integration ref, Forge unavailable, Seeded audit with a confirming scout — all 7 with spec severities, default target, Not initialized, Audit routed, Audit scout not inline, bad target), `tests/extension.test.ts` (Usage lists subcommands incl. `audit`).
- Focused: `bunx vitest run tests/audit tests/commands tests/engine/git.test.ts tests/extension.test.ts` → 15 files, 210 passed.
- Final: `bun run typecheck` exit 0; `bun run test` → 237 files, 3511 passed.

## Contract deviations (internal, recorded in plan.md)

- `AuditDeps.severity?: unknown` added — the pack's `decisions.drift-severity`, forwarded to `classify` (mirrors `askBehaviorChanges`).
- `deliverReport` added in `report.ts` — D10 destination rule as one unit; a failed `createComment` prints the report with the error instead of failing the command.
- No public contract changed (CLI `/livespec audit [#T]`, marker `drift-report` format, triage command, `ScoutVerdict` as specified).

## Concerns

- `auditReply` passes `state: { pending: [] }` (as instructed); default target / fix cursor only matter after Task 8.
- "Not initialized" reuses the existing `NOT_INITIALIZED` text ("livespec is not set up in this project: run /livespec init first.").
- The audit worktree links dependency folders (`withTempWorktree` without `setup`), never runs `verify.setup`.
- Report rendering wraps forge-derived free text (fetch error, refuted reason, unmatched keys, forge errors) in `untrusted()`; item keys/evidence come from the repo tree and are printed as-is (same trust as spec text shown elsewhere in the session).
- Bad `#T` argument returns usage with an error notice; spec does not cover it (assumption).

## Fix round 1

Changes
- `src/audit/triage.ts`: regex now `^/livespec triage (.+) (major|minor|ignore)$` — verdict is the last word, key may hold spaces. Command format unchanged.
- `src/audit/confirm.ts`: spec path is wrapped with `untrusted()` (fixed `## Spec` heading); verdicts applied only for status `DONE`/`DONE_WITH_CONCERNS`, otherwise items stay unconfirmed with a note.

Covering tests
- triage.test.ts: multi-word key by a writer (ignored), by a reader (unchanged).
- confirm.test.ts: capability with newline and `<` stays inside wrapper; BLOCKED and NEEDS_CONTEXT with a `refuted` verdict keep items unconfirmed.

Commands
- RED (`bunx vitest run tests/audit`): 4 failed (multi-word writer, newline path, BLOCKED, NEEDS_CONTEXT).
- GREEN: `bunx vitest run tests/audit tests/commands/audit.test.ts` all pass; `bun run typecheck` clean; `bun run test` all pass.

## Fix round 2

- `tests/audit/confirm.test.ts`: after the positive wrapper assertion, strips every `<untrusted>…</untrusted>` block (multiline) and asserts the remainder lacks `IGNORE ALL`.
- RED: heading temporarily reverted to raw `${path}` → the new assertion failed (1 failed). Restored → 11/11 pass; typecheck clean.
