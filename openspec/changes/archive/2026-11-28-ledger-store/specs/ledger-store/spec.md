## ADDED Requirements

### Requirement: Ledger ref and layout
Each change SHALL have at most one ledger: the git ref `refs/livespec/<issue>` in the clone's common git directory, shared by every worktree of the clone, with no commit in common with any branch. Its tree SHALL hold `ledger.yaml` (`schema: 1` and the issue number) and, once an entry of the kind exists, `decisions.jsonl` (`decision`), `dispatch.jsonl` (`dispatch`), `findings.jsonl` (`finding-summary`), `units/<unit>.yaml` (`unit-start` and `receipt` of that unit) and `change.yaml` (`counter`). JSONL files SHALL hold one entry per line; YAML files a sequence of entries. The ledger MUST NOT be read as the source of any human decision.

#### Scenario: First record creates the ref
- **WHEN** `unit_start U1` succeeds on change #59, which has no ledger yet
- **THEN** `refs/livespec/59` exists, its tree holds `ledger.yaml` and `units/U1.yaml` with one `unit-start` entry, and no branch shares a commit with it

#### Scenario: Shared between worktrees
- **WHEN** a lane worktree of change #59 appends a `dispatch` entry
- **THEN** the change worktree reads that entry from `refs/livespec/59` without any fetch

### Requirement: Ledger entries
Every entry SHALL hold `ref`, `kind`, `id`, `seq`, `at`, optional `after`, optional `from`, and `data`. `ref` SHALL be a unique entry id `<id>~<8 lowercase hex>`, generated at append and never reused; `kind` and `id` the record kind and the record id its writer uses; `seq` the 1-based position in the ledger; `at` the ISO 8601 UTC append time; `after` the reference of the latest own marked forge comment in the state the writer read, absent when there was none; `from` the forge comment id the entry was migrated from, written only by a migration and absent otherwise. A reference to a record (a rebutted summary, a verified finding, a receipt's start) SHALL match an entry whose `ref` or `from` equals it. Only the six ledger kinds SHALL be accepted. An entry MUST NOT be changed or removed, except that a replay (see "Ledger sync") MAY renumber `seq`.

#### Scenario: Two records with the same id
- **WHEN** `unit_finish U1` fails twice
- **THEN** the ledger holds two `decision` entries with id `progress.U1` and different `ref` values

#### Scenario: Unknown kind refused
- **WHEN** a tool tries to append an entry of kind `lane`
- **THEN** the append throws and the ref does not move

#### Scenario: Reference by migrated comment id
- **WHEN** a `finding-summary` entry has `from: "501"` and a rebuttal entry has `rebuts: "501"`
- **THEN** the findings of that summary count as rebutted

### Requirement: Ledger fetched before use
Before a tool reads or writes the change state of change `<n>`, the session SHALL have fetched the ledger successfully at least once. The fetch SHALL run the fetch, fast-forward and replay steps of "Ledger sync", without the push. It SHALL count as successful when `origin` has no `refs/livespec/<n>`, and when the clone has no `origin` remote, since no other clone can then hold entries. A successful fetch SHALL be remembered for the session and not repeated by later reads. The phase card at session start SHALL NOT wait for it: it reads the local ref. When the fetch fails and the clone has a local or remote-tracking ledger of the change, the tool SHALL continue with a warning that the ledger may be out of date. When the fetch fails and the clone has neither, a tool that writes MUST refuse before any other work, writing nothing, and say that the ledger could not be fetched; read-only tools SHALL continue with a warning.

#### Scenario: Second machine sees the first machine's records
- **WHEN** clone A appended U1's receipt and synced, and a new session on clone B, which never fetched the ledger, runs `unit_start U2` with `Depends: U1`
- **THEN** clone B fetches the ledger first, U1 counts as done, and U2 starts

#### Scenario: Unknown ledger while offline
- **WHEN** clone B has no local or remote-tracking ledger of change #59, `origin` is unreachable, and `unit_start U2` runs
- **THEN** the tool refuses, writes nothing, and says the ledger could not be fetched

#### Scenario: New change, empty remote
- **WHEN** `origin` is reachable and has no `refs/livespec/59`, and `unit_start U1` runs on change #59
- **THEN** the fetch counts as successful, and U1 starts and creates the ledger

#### Scenario: Known ledger while offline
- **WHEN** clone B has a local ledger of change #59 and `origin` is unreachable
- **THEN** `unit_start U2` runs against the local ledger and the result carries a warning that it may be out of date

### Requirement: Entry version
The version of an entry SHALL be the SHA-256 of the JSON of its `ref`, `kind`, `id`, `at`, `after`, `from` and `data` (absent optional fields left out), with object keys sorted and no whitespace. `seq` MUST NOT be part of it, so a replay never changes a version.

#### Scenario: Version kept across a replay
- **WHEN** an entry is replayed onto a remote tip and gets a new `seq`
- **THEN** its version is unchanged, and a packet that cited it passes the freshness check

### Requirement: Invalid ledger content
Reading a ledger SHALL skip, with one warning each, an entry that is not valid JSON or YAML, lacks a field, has a kind not allowed in its file, or repeats a `ref` already read. A ledger whose `ledger.yaml` is missing, unreadable, or has a `schema` other than `1` or another issue number SHALL be read as empty, with a warning naming the reason. A gap or a repeat in `seq` SHALL NOT invalidate entries; the file order SHALL decide.

#### Scenario: Corrupt line
- **WHEN** `findings.jsonl` has one valid line and one line that is not JSON
- **THEN** the valid entry is read and the state carries one warning naming `findings.jsonl`

#### Scenario: Unknown schema
- **WHEN** `ledger.yaml` holds `schema: 2`
- **THEN** the change state has no ledger entries and a warning names the schema

### Requirement: Ledger append
An append SHALL add one entry in one commit whose parent is the current tip, using git plumbing only, without touching the index or any working tree. The ref SHALL move by compare-and-swap on the tip read; when another writer moved it first, the append SHALL retry on the new tip up to five times, then fail and write nothing. Every ledger commit SHALL use `livespec <livespec@localhost>` as author and committer, whatever the git identity configuration. An append MUST NOT fail because the forge or `origin` is unreachable, except for the refusal of "Ledger fetched before use" when no ledger of the change is known; it SHALL then run a sync whose failure does not fail the append.

#### Scenario: Two local sessions append at once
- **WHEN** two sessions in two worktrees of one clone append to `refs/livespec/59` at the same time
- **THEN** both entries are in the ledger with `seq` 1 and 2

#### Scenario: Dirty tree does not matter
- **WHEN** the working tree has uncommitted changes and an entry is appended
- **THEN** the working tree and the index are unchanged

#### Scenario: Forge down
- **WHEN** the forge is unreachable and a `dispatch` entry is appended to the ledger
- **THEN** the entry is in the local ledger and the append does not fail

#### Scenario: No git identity
- **WHEN** `user.name` and `user.email` are not configured and an entry is appended
- **THEN** the append succeeds with author and committer `livespec <livespec@localhost>`

### Requirement: Ledger sync
A sync of change `<n>` SHALL use only `origin`. It SHALL fetch `refs/livespec/<n>` into `refs/livespec-origin/<n>`. When the local ledger is absent or an ancestor of the remote one, it SHALL fast-forward the local ref. When they diverged, it SHALL append every local entry whose `ref` the remote lacks, in local file order, onto the remote tip in one commit, keeping all fields but `seq`, and move the local ref by compare-and-swap; a lost compare-and-swap SHALL restart the sync. When the local ledger is then ahead, or the remote ledger is absent, it SHALL push without force; a rejected push SHALL restart the sync, at most three times. No entry of either side MUST be lost.

#### Scenario: Two machines append concurrently
- **WHEN** clone A and clone B each append one entry to ledger #59 from the same tip, and A pushes first
- **THEN** B's push is rejected, B replays its entry onto A's tip and pushes, and both clones end with both entries

#### Scenario: Remote ledger absent
- **WHEN** a change's first entry is appended and `origin` has no `refs/livespec/<n>`
- **THEN** the sync pushes the local ledger and `origin` has it

### Requirement: Sync result and triggers
A sync SHALL end `synced` when local and remote tips are equal, `pending` when local entries are not on `origin` (unreachable, no `origin`, or retries used up), or `error` with the git message. A sync SHALL run after every append, at session start for the current change without delaying the session start (to push pending entries), in `change_ship` and in `change_close`. Reading the change state MUST NOT fetch, except for the first fetch of "Ledger fetched before use"; it SHALL report a pending sync as a warning when the local tip exists and is not `refs/livespec-origin/<n>` nor an ancestor of it.

#### Scenario: Offline append
- **WHEN** `origin` cannot be reached and an entry is appended
- **THEN** the entry is local, the sync result is `pending`, and the change state carries a ledger warning

#### Scenario: Pending entries pushed later
- **WHEN** a session starts on a change whose ledger has pending entries and `origin` is reachable
- **THEN** the session-start sync pushes them and the warning is gone at the next state read

### Requirement: Ledger records in the change state
The change state's own records SHALL be one ordered list of the own marked comments, in forge order, and the ledger entries of the change. Each entry SHALL follow the comment its `after` names; an entry whose `after` is absent or names no current own comment SHALL follow the last own comment created at or before its `at`, and SHALL come before every comment when there is none. Entries placed after the same comment SHALL keep ledger file order, by `seq`. Every "latest" and "newer" between records, of either source, SHALL use this list. Each record SHALL say its source and carry its reference: the comment id or the entry `ref`. A change with no ledger SHALL read as one with no entries.

#### Scenario: Receipt before a later rebuild
- **WHEN** U2's receipt entry has `after: c7`, and the review later posted `rebuild.U2.1` as comment `c9`
- **THEN** the list holds the receipt before `rebuild.U2.1`, and U2 is not receipted-not-ticked

#### Scenario: Unit start after a park
- **WHEN** a `parked` comment `c5` lists U3 and a later `unit-start` entry for U3 has `after: c5`
- **THEN** the list holds the `unit-start` after `c5`, and U3 counts as started

#### Scenario: Latest counter after a replay
- **WHEN** two `counter` entries `custom_loop` follow comments `c5` (value 1) and `c7` (value 2), and a replay gave the first a higher `seq`
- **THEN** `custom_loop` reads 2

#### Scenario: No ledger
- **WHEN** the change has no `refs/livespec/<issue>`
- **THEN** the state has no receipts, starts, dispatch, finding or decision records, and no error

### Requirement: Ledger retention
The project config key `ledger.retain` SHALL default to `true`, and the ledger SHALL then be kept after close. With `false`, `change_close` SHALL, after the change issue is closed, sync the ledger, delete `refs/livespec/<issue>` on `origin` under a lease on the synced tip, then delete the local ref and `refs/livespec-origin/<issue>`. A failed remote delete MUST NOT fail the close; the result SHALL name it and the local refs SHALL still be deleted. A ledger left on `origin` by a failed delete, a ledger another clone pushes again later, and the ledger of a change closed with `--abandon` SHALL be kept; these are accepted limits.

#### Scenario: Default keeps the ledger
- **WHEN** `change_close` closes change #59 with no `ledger` config
- **THEN** `refs/livespec/59` still exists locally and on `origin`

#### Scenario: Retain false deletes it
- **WHEN** the project config sets `ledger: { retain: false }` and `change_close` closes change #59
- **THEN** `refs/livespec/59` is gone locally and on `origin` after the issue is closed

#### Scenario: Remote delete fails
- **WHEN** `ledger.retain` is `false` and `origin` is unreachable during `change_close`
- **THEN** the issue is closed, the local refs are deleted, and the tool result names the failed remote delete
