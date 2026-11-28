## Why

Machine records flood the change issue: one real change produced 52 comments and about 75 KB of YAML before its pull request existed, 42 of them rule decisions, finding summaries and dispatch records. ADR 0002 makes the issue both the human surface and the state store. LS-12a (#59) is the first step of LS-12 (#58): move tool-generated records to a git ledger so later parts can make the forge readable for people.

## What Changes

**Machine records leave the forge**
- From: `decision`, `dispatch`, `finding-summary`, `receipt`, `unit-start` and `counter` are own marked comments on the change issue.
- To: they are entries of an append-only ledger on the custom git ref `refs/livespec/<issue>`, laid out as `change.yaml`, `units/<U>.yaml`, `dispatch.jsonl`, `findings.jsonl` and `decisions.jsonl`. No comment of these kinds is posted. Readers see one ordered record list that merges ledger entries with the remaining own marked comments in causal order.
- Reason: the issue stops being a machine state store for these kinds.
- Impact: **breaking for changes in flight**. Comments of the six kinds written by earlier versions are ignored (ledger only, no dual read); such changes must be finished on the previous version or wait for the migration in #62.

**Concurrency and offline**
- From: comment writes go to the forge; read-only mode refuses every write; the counter comment is edited in place with a version check.
- To: a ledger append is a compare-and-swap update of the local ref followed by a fast-forward-only push to `origin`; a rejected push fetches, replays the local entries on the remote tip and retries. An unreachable remote leaves entries local until the next sync. Each session fetches a change's ledger once before first use; while offline, a tool that would append refuses only when this clone has never seen that change's ledger. Counters become appended entries, the latest wins. Entries carry an optional `from` (migrated comment id) for #62.
- Reason: two sessions writing at once must never lose a record, and a record must not depend on forge reachability.
- Impact: non-breaking for tools; `change_ship` refuses while ledger entries are not pushed.

**Public references**
- From: packet sources `comment:<id>`, `finding_rebut <commentId> ...`, the verifier reference `finding: <comment id>:<index>`, and `unit_finish` links to comment URLs name forge comments of the moved kinds.
- To: they name ledger entries: source `ledger:<issue>/<entry-id>`, `finding_rebut <entry-id> ...`, `finding: <entry-id>:<index>`, and `ledger:<issue>/<entry-id>` references instead of comment links. Other `comment:<id>` sources are unchanged.
- Reason: moved records have no comment id.
- Impact: **breaking** for the `finding_rebut` parameter and the verifier reference (approved).

**Retention and guards**
- Project config `ledger.retain` (default `true`); with `false`, `change_close` deletes the ref, locally and on `origin`, after the change issue is closed.
- Fetch, push and delete of the ledger ref run only in the guarded push module; agent bash commands that write `refs/livespec/*` are blocked.

## Capabilities

### New Capabilities
- `ledger-store`: the ledger ref, its layout and entry shape (including `from`), append, fetch before first use, merged ordering with forge records, sync (fetch, replay, push), offline behaviour, ship-time sync and retention.

### Modified Capabilities
- `forge-markers`: the six moved kinds are no longer comment kinds; forge comments of those kinds are ignored with a warning; the marker example uses a forge kind.
- `forge-cache`: read-only mode does not refuse ledger appends.
- `flow-engine`: change state is built from the issue, git and the ledger; loop counters come from ledger entries; ledger appends do not drop the comments cache.
- `approver-adapters`: a `decision` result is a ledger entry, and a request is completed by its result record from either source.
- `decision-seam`: decision records are ledger entries.
- `durable-doc-checks`: the `behavior-change` decision is a ledger entry.
- `phase-gates`: the `gate-escalation` decision is a ledger entry.
- `subagent-dispatch`: dispatch records (including `QUESTION`/`ANSWERED`) are ledger entries; packets cite them as `ledger:` sources.
- `subagent-packets`: new source id form `ledger:<issue>/<entry-id>`; freshness and untrusted wrapping treat ledger entries as own records.
- `review-findings`: finding summaries and rebuttals are ledger entries; `finding_rebut` takes an entry id.
- `finding-routing`: the aggregate and the `finding-scope` decision are ledger entries; the aggregate lists entry ids; question keys and PR-less findings name the aggregate entry.
- `review-phase`: the `tags.review` decision and the round-cap counter rule refer to ledger entries.
- `discovered-dependencies`: the derived `discovered_deps` counter ignores counter entries.
- `unit-evidence`: `unit-start` and `receipt` are ledger entries; `unit_finish` names records by ledger reference.
- `parallel-lanes`: the lane worktree is never resolved from a `unit-start` entry (wording follows the move).
- `change-close`: ledger deletion when `ledger.retain` is `false`.
- `ship-phase`: `change_ship` syncs the ledger and refuses while entries are unpushed.
- `command-guards`: the guarded push module also owns the ledger fetch, push and delete; agent writes to `refs/livespec/*` are blocked.
- `init-and-doctor`: project config accepts `ledger.retain`.
- `drift-audit`: the audit scout writes no `dispatch` ledger entry (wording follows the move).

## Impact

- Code: new `src/ledger/` (store, entry codec, sync, merge with marked comments); `src/guard/push.ts` (ledger push, fetch, delete), `src/guard/rules.ts`/`classify.ts` (ref guard); `src/forge/markers.ts`; `src/engine/snapshot.ts`, `src/engine/counters.ts`; writers in `src/decide/records.ts`, `src/subagents/records.ts`, `src/subagents/run-record.ts`, `src/subagents/dispatch.ts`, `src/subagents/resume.ts`, `src/subagents/in-flight.ts`, `src/evidence/records.ts`, `src/review/stages.ts`, `src/review/records.ts`, `src/interaction/complete-*.ts`, `src/tools/{unit-start,unit-finish,finding-rebut,subagent-answer,plan-units-steps,change-ship,change-close}.ts`; packet sources in `src/subagents/sources-records.ts`; `src/config.ts`.
- Tests: new ledger tests against real temporary git repos (bare remote plus two clones/worktrees); test helpers that seed moved kinds write ledger entries.
- Docs: new ADR 0008 refining 0002 and 0007, `docs/architecture.md`, `docs/glossary.md`, README and README.vi.md (config key), CHANGELOG Unreleased (breaking notes).
- Dependencies: none (git CLI already required).
- Archive note: the `## Purpose` lines of `unit-evidence` ("receipts on the change issue") and `decision-seam` ("decision records on the issue") need a manual edit at sync/archive; deltas cannot change Purpose.
- Out of scope: the plan gate's cascade baseline (`requirements`, `requirement_scope`, from #63) stays on the `gate` comment until gates move in #61.
