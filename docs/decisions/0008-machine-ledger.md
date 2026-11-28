# 0008: Machine records live in a git ledger

Status: Accepted (2026-11-28)

Refines [0002](0002-issue-is-source-of-truth.md) and [0007](0007-forge-concurrency-by-adapter.md): the issue stays the human surface and the source of truth for gates, answers and the change body, but tool-generated records of six kinds no longer live in issue comments.

## Context

ADR 0002 makes the issue both the human surface and the state store. Every tool result became an own marked comment with a YAML payload. One real change produced 52 comments and about 75 KB of YAML before its pull request existed, 42 of them rule decisions, finding summaries and dispatch records (#58, #59). People could no longer read the issue. Comment writes also depend on forge reachability and have no compare-and-swap (ADR 0007).

## Decision

**Ledger.** One append-only ledger per change on the git ref `refs/livespec/<issue>`, an orphan history in the clone's common git dir (shared by every worktree and lane). Its tree holds `ledger.yaml` (`{ schema: 1, issue }`), `decisions.jsonl`, `dispatch.jsonl`, `findings.jsonl`, `units/<U>.yaml` and `change.yaml`.

**Six kinds.** `decision`, `dispatch`, `finding-summary`, `receipt`, `unit-start` and `counter` are ledger entries. No comment of these kinds is written; comments of these kinds written by earlier versions are ignored with a warning (no dual read). Other kinds (`gate`, `request`, `answer`, `stale`, `amendment`, `parked`, `rebuild`, `stuck`, `lane`, `review-run`, …) stay own marked comments.

**Entries.** `{ ref, kind, id, seq, at, after?, from?, data }`. `ref` is the unique id `<id>~<8 hex>`, `id` the record id writers already use, `seq` the 1-based position, `at` the write time, `after` the causal anchor (the latest own marked comment the writer had seen), `from` a forge comment id reserved for the later migration (#62). Files are only appended to; `seq` is renumbered only by a replay.

**Plumbing commits.** An append builds the tree in a temporary index (`hash-object`, `read-tree`, `update-index`, `write-tree`, `commit-tree`) and moves the ref with `update-ref <new> <old>` (compare-and-swap, retried up to 5 times). The real index and working tree are never touched. Commits use the fixed identity `livespec <livespec@localhost>`.

**Sync.** Remote is always `origin`; the tracking copy is `refs/livespec-origin/<issue>`. Sync fetches, then fast-forwards the local ref, or replays the local entries missing on the remote onto the remote tip when the histories diverged (matching by `ref`, so nothing is lost), then pushes without force. A rejected push restarts the sync (at most 3 times). An append runs a best-effort sync after the local commit and never fails because of it; an unreachable remote leaves the entry local (`pending`) until the next sync.

**Fetch before first use.** Each session fetches a change's ledger once before the first state read of that change. Reads then use only the local ref. When the fetch fails and no ledger is known locally, appends refuse (an empty read would fork the state); with a known ledger, tools continue with a warning.

**Ordering.** Readers keep one list: forge comments in forge order, each entry placed right after its `after` anchor, entries with one anchor in file order. A lost anchor falls back to the last comment created before `at`. Every "newer than" comparison uses positions in this merged list, never `seq` or timestamps alone.

**Ship.** `change_ship` syncs before it pushes the branch and refuses unless the ledger is pushed, so reviewers on another machine see every receipt and finding.

**Retention.** Project config `ledger.retain` (default `true`). With `false`, `change_close` deletes the ref locally and on `origin` after closing the issue. A failed remote delete does not fail the close.

**References.** Public references name entries: packet source `ledger:<issue>/<ref>`, `finding_rebut <ref> <index>`, verifier `finding: <ref>:<index>`.

**Trust.** Entries carry no author check. Whoever can push `refs/livespec/*` to `origin` can write state; that is the set of people who can push branches. Human authority stays on the forge (gates and answers).

**Guards.** Fetch, push and delete of the ledger ref run only in the guarded push module (`src/guard/push.ts`), refspecs built from a positive integer issue number. The bash guard blocks agent git commands that name `refs/livespec` or `livespec-origin`, except read subcommands (`log`, `show`, `cat-file`, `rev-parse`, `rev-list`, `ls-tree`, `ls-remote`, `for-each-ref`, `diff`), and blocks `update-ref --stdin` and wildcard destination refspecs outside `refs/remotes/`. Accepted limits, as for other refs (ADR 0004): other plumbing (`pack-refs`, `replace`), refspecs from git config, ref names behind shell expansions, unmodelled git subcommands and direct writes under `.git`.

## Consequences

- **Breaking for changes in flight.** Receipts, decisions, dispatch and finding records, unit starts and counters written as comments by earlier versions are ignored. Finish such a change on the previous version, or wait for the migration (#62).
- `finding_rebut` takes a ledger entry ref as its first argument, and the verifier `finding` reference is `<aggregateRef>:<index>`.
- The plan gate's cascade baseline (`requirements`, `requirement_scope`) stays on the `gate` comment until gates move (#61).
- Readers stay merged (comments plus ledger) until all machine kinds have moved.
- Tools that write only to the ledger still refuse in forge read-only mode; only the ledger layer is offline-capable.
- A counter set concurrently from a stale read can lose an increment, as with the former last-write-wins comment edit.
- Accepted limits: a remote ref left by a failed delete, a ledger another clone pushes again later, and `--abandon` closes keep their ledger.
- An older version ignores `refs/livespec/*`, so a rollback mid-change has the same effect as the upgrade.
