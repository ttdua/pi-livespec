## Design Summary

LS-03 adds the forge layer: one `Forge` interface with a GitHub adapter (through the `gh` CLI) and a Gitea adapter (REST `/api/v1`), plus the pieces both share: comment markers, label conventions, a local issue cache, fail-closed writes and a read-only mode when the forge is unreachable.

The goal is that the engine and later specs (LS-04 to LS-09) never see forge details. They call `Forge`, and every write either succeeds against the version the caller read or is refused.

Existing requirements touched: the living specs `package-scaffold` and `host-seam-evidence` are not altered. This change adds a new capability (`forge-layer`) and consumes probe (g) of `docs/evidence/host-seams.md`.

It does alter one decision in prose: ADR 0002 said "local copy is a cache with ETags". ADR 0007 already replaced that with an opaque `version` per adapter. This change implements ADR 0007 and does not re-decide it.

Behavior in plain terms:

- **Read an issue or PR:** returns its fields plus an opaque `version`. The version is whatever the adapter can use later to detect a change.
- **Edit an issue or PR body:** the caller passes the `version` it read. If the forge copy changed since, the edit is refused with a `Conflict` that says what changed.
- **Comments written by the plugin:** start with a marker. Only marked comments written by the current account count as state. A marked comment from anyone else is ignored and reported as a warning.
- **Labels:** `livespec`, `livespec:phase/<phase>`, `livespec:initiative`, `livespec:parked`. A missing label is created the first time it is needed.
- **Forge unreachable:** reads come from the cache and are marked stale. Every write is refused with a clear message.
- **Detection and auth:** GitHub through the `origin` host (or a configured Enterprise host) and `gh auth status`. Gitea through config or probing `/api/v1/version`, with a token from `GITEA_TOKEN` or the `tea` config file. The adapter never runs `tea`.
- **Tests:** one contract suite runs against both adapters, using a fake `gh` executable and a loopback fake Gitea server. No network beyond loopback and no secrets.

## Alternatives Considered

### Alternative A: Re-read, compare, then write on GitHub (chosen for GitHub)
- **Approach**: Right before the PATCH, read the issue again and compare its body hash and `updated_at` with the caller's `version`. Refuse on mismatch.
- **Pros**: Needs no server support; works with plain `gh api`; no extra writes.
- **Cons**: A small race window remains between the re-read and the PATCH.
- **Why not chosen**: It is chosen. GitHub has no conditional write, and the window is far smaller than the time between the caller's read and its write, which is the case that matters.

### Alternative B: Lock comment around the write
- **Approach**: Post a lock comment on the issue, write, remove the lock.
- **Pros**: Shrinks the race further against other plugin users.
- **Cons**: Two extra writes per edit, noisy timeline, stale locks after a crash, and it does not stop humans editing.
- **Why not chosen**: More cost and new failure modes for little gain.

### Alternative C: Read-compare-write on every forge (no `content_version`)
- **Approach**: Use the same re-read check for Gitea instead of `content_version`.
- **Pros**: One code path.
- **Cons**: Gives up Gitea's server-side check, which closes the race fully (409 on stale).
- **Why not chosen**: ADR 0007 already chose per-adapter mechanisms, and Gitea has a real one.

## Agreed Approach

Per-adapter concurrency behind one opaque `version`, as in ADR 0007:

- GitHub: re-read and compare before write (Alternative A).
- Gitea: capability is detected per response, never by a version number and never up front. If the issue or PR JSON carries `content_version`, the adapter sends it on edits and treats a 409 as `Conflict`. If the field is absent (older server), the adapter uses the same re-read and compare check as GitHub and records that the check is best-effort in the `WriteResult`. Nothing is blocked because of the server version.
- Failures are blocked only when a real call fails (HTTP error, `Conflict`, auth, network). The error names the operation and the status.
- Comment edits are last-write-wins on both forges, and the adapter only edits comments that carry its own marker and account.
- Everything is built behind the `Forge` interface sketched in issue #3 with `version` replacing the ETag, and covered by one contract suite.

## Key Decisions

- The `Forge` interface exposes `version` (opaque) instead of an ETag, per ADR 0007.
- GitHub concurrency is a pre-write re-read and compare (answered in review thread).
- Gitea without `content_version` falls back to the GitHub-style re-read and compare. There is no minimum version and no startup version gate; only a real failed call blocks (revised after review thread feedback; replaces the earlier "refuse body writes" answer).
- Gitea transport is Node's built-in `fetch`; GitHub transport is `gh api`. No SDKs.
- Marked comments from another account are ignored with a warning, with no exceptions.
- Who may call writes is out of scope (LS-06 guards), and so is what issue bodies mean (LS-02).
- A manual smoke run against one real repository on each forge is recorded in the change.

## Open Questions

- Which Gitea releases have `content_version`? It is checked against Gitea release notes and recorded in `design.md` as information only, not as a gate. The probe ran on 28.3.0.
