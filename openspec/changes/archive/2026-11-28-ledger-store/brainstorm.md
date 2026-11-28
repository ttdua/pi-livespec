## Design Summary

LS-12a (#59), part 1 of LS-12 (#58, human-readable forge surface). Machine records stop being forge comments and move to a git ledger on the custom ref `refs/livespec/<issue>`. The forge keeps what a human must read, decide or follow; tools read their own machine state back from the ledger.

**Why.** A real change produced 52 comments and about 75 KB of YAML before its pull request existed; 26 were rule decisions, 9 finding summaries, 7 dispatch records. ADR 0002 treats the issue as both the human surface and the state store. This change removes the state-store role for tool-generated records.

**Goals**
- The records of kind `decision`, `dispatch`, `finding-summary`, `receipt`, `unit-start` and `counter` are written to and read from the ledger only. No comment of these kinds is posted on any issue.
- Two sessions (two machines, or two worktrees of one clone) writing the same ledger at the same time never lose a record.
- Ledger writes work while the forge or the remote is unreachable; they stay local and sync later.
- `ledger.retain` (default `true`) keeps the ref after close for post-mortems; `false` makes `change_close` delete it after the close summary.
- Every fetch and push of the ledger ref goes through the guarded push path; the agent cannot write the ref itself.

**Non-goals (later LS-12 parts)**
- Other machine kinds (`lane`, `rebuild`, `review-run`, `stale`, `incomplete`, `parked`, `ship`, `skill-note`, `request`/`answer`, `amendment`, `gate`, `question`, `stuck`, `close-summary`, `new-dependency`, `drift-report`) stay on the forge in this change. Gates and questions move in #60/#61; the issue body and migration in #62.
- No draft pull request, no reaction-based gates, no rendering of ledger data into human comments.
- No migration of existing comment records into a ledger (that is #62).

**Anti-goals**
- Human decisions becoming authoritative in the ledger. The ledger holds tool-generated data only; human authority stays on the forge.
- Losing a record silently on a concurrent write, or a write that fails closed just because the forge API is down.
- The agent (bash) being able to forge or rewrite ledger entries.

**Affected living specs and what changes**
- `forge-markers` "Core kinds and registration": the six moved kinds are no longer forge comment kinds. "Only own marked comments count" stays for the remaining kinds. This alters a specified requirement.
- `forge-cache` "Read-only mode": ledger writes are not refused in read-only mode; they stay local. This alters a specified requirement.
- `forge-interface`: unchanged contract; the ledger is git, not a `Forge` operation (to confirm in design).
- `decision-seam` "Decision records": decision records live in the ledger (`decisions.jsonl`), not as `decision` comments.
- `subagent-dispatch` "Dispatch record" and "Questions from a child": `dispatch` records live in the ledger; packets read discoveries and results from the ledger.
- `review-findings` "Finding summary comment" and "Rebuttal", and `finding-routing` "Aggregate findings" / "Finding scope rule": `finding-summary` and the `finding-scope` decision live in the ledger.
- `unit-evidence` "Unit start tool", "Receipt", "Unit finish tool", "Unit attempts": `unit-start` and `receipt` live in the ledger; `counter` too.
- `subagent-packets` "Source ids and versions" and "Freshness before finish": a new source id form for ledger entries replaces `comment:<id>` for moved records.
- `change-close` "Close tool": deletes the ref when `ledger.retain: false`.
- `command-guards` "Guarded push": covers the ledger ref; agent writes to `refs/livespec/*` are blocked.

## Alternatives Considered

### Alternative A: Grouped append-only files (#59 layout)
- **Approach**: Each write is one commit on `refs/livespec/<issue>` holding `change.yaml`, `units/<U>.yaml`, `dispatch.jsonl`, `findings.jsonl`, `decisions.jsonl`, `gates.jsonl`. On a rejected push, fetch the remote tip, re-append the local entries the remote lacks, and push again; append-only means the merge is a union, never a content conflict.
- **Pros**: matches the agreed #59 layout; readable for auditors with plain `git show`; few files.
- **Cons**: needs a replay step on rejection.
- **Why not chosen**: chosen.

### Alternative B: One file per entry
- **Approach**: `entries/<kind>/<id>.yaml`; concurrent writes merge by tree union.
- **Pros**: trivial merge.
- **Cons**: deviates from the #59 layout, many tiny files, harder to read in a post-mortem.
- **Why not chosen**: the merge saving is small next to a layout the issue already agreed and auditors read.

### Alternative C: git notes on change commits
- **Approach**: attach records as notes to commits.
- **Pros**: native git feature.
- **Cons**: needs a commit before any record exists; notes follow commits through rebase badly; not keyed by issue.
- **Why not chosen**: does not fit records that exist before the first commit.

### Transition alternatives (decided separately)
- **Dual read** (old comments read-only plus ledger) was offered and rejected.
- **Ledger only** was chosen: changes in flight lose their comment-based receipts, counters and decisions under the new version; they must be finished on the previous version or wait for #62's migration. This is a breaking change for in-flight changes and is stated as such.

## Agreed Approach

Alternative A with ledger-only reads. The ledger is the single store for the six moved kinds; entries keep the kind and id they have today as markers (for example `finding-summary.change.review.2`, `progress.U1`). Those ids are not unique (a decision id repeats per attempt), so every entry also gets its own unique entry id, which is what external references name. Every write appends; nothing is edited in place (a counter update is a new entry, the last one wins on read). Concurrency is fast-forward-only push with fetch-and-retry for the remote and a compare-and-swap ref update locally, replacing the ETag fail-closed rule for these records. Offline writes commit locally and are pushed on the next successful sync.

## Key Decisions

- **Scope of moved kinds**: exactly `decision`, `dispatch`, `finding-summary`, `receipt`, `unit-start`, `counter` (user, from #59).
- **Ledger only, no dual read** (user): breaking for in-flight changes; called out in proposal and changelog.
- **Layout** A (user approved the proposal).
- **Public id change** (user approved): the packet source id `comment:<id>` becomes `ledger:<issue>/<entry-id>` for moved records; `finding_rebut` and the verifier `finding:` reference take the unique ledger entry id instead of a comment id. Other `comment:<id>` sources (human comments, kinds still on the forge) are unchanged.
- **Retention**: `ledger.retain` default `true` (from #59 agreed defaults).
- **Authority**: ledger holds tool-generated data only; human decisions are not authoritative there (from #59).
- **Offline is about the git remote, not the forge API**: a write never fails because the forge is unreachable; it fails only on a local git error. (My call: the remote and the forge API are different reachability facts.)
- **Local concurrency**: two worktrees of one clone share the local ref, so local updates are compare-and-swap too. (My call.)
- **Guard**: agent bash commands that push, fetch-into, update or delete `refs/livespec/*` are blocked; only the ledger module writes it. (My call, consistent with ADR 0004.)
- **Guard strength**: the guard is the existing pi-side command guard (ADR 0004), a policy boundary over the agent's tool calls, not an OS boundary. It blocks agent git commands that touch `refs/livespec/*`; direct `.git` file writes are out of reach, as for other guarded refs today. (My call.)
- **Counters**: keep today's semantics, last write wins (today a counter comment edit is last-write-wins too). No record is lost; a concurrent stale increment can still lose a count, as today. (My call.)
- **Missing ledger**: a change with no ledger ref reads as an empty ledger; this is the accepted consequence of ledger-only for in-flight changes. (My call.)
- **Remote**: `origin`, the same remote the guarded push path uses today. (My call.)
- **Delete on close**: with `retain: false`, a failed remote delete (offline, protected ref) does not fail the close; it is reported in the tool result and the local ref is still removed. (My call.)
- **Sync before ship**: `change_ship` syncs the ledger and refuses while local ledger entries cannot be pushed, so another machine or reviewer can read the receipts of a shipped change. Other tools only sync best-effort. (My call.)
- **New ADR**: refines 0002/0007 for machine records; `docs/architecture.md` updated. (From #58 Docs.)

## Open Questions

- Left to design: exact ledger entry shape, which file each kind lands in (`gates.jsonl` gets no writer in this change unless design finds one), sync triggers (on write, on session start, before reads), the fetch refspec, and how reads stay fresh without fetching on every snapshot.
- Left to design: where `ledger.retain` sits in the existing config files.
