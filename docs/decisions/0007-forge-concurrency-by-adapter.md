# 0007: Write concurrency is checked per forge adapter

Status: Accepted (2026-11-13)

Refines [0002](0002-issue-is-source-of-truth.md): the rule "writes fail closed when the issue changed since it was read" stays; the mechanism is no longer ETags for every forge.

## Context

ADR 0002 says the local copy is a cache with ETags. Probe (g) in [host-seams evidence](../evidence/host-seams.md) ran against Gitea 28.3.0: the server sends no ETag on issues and ignores `If-Match` and `If-Unmodified-Since` on edits. It offers `content_version` on issue and pull request edits (409 when stale), and has no version at all on comment edits.

## Decision

- The `Forge` interface exposes an opaque `version` for each issue or pull request body, and an edit takes that `version`. A stale edit fails closed.
- Each adapter chooses the mechanism: Gitea uses `content_version`; GitHub uses its own check, to be settled in LS-03.
- Comments written by the plugin are found by marker and edited only when they carry the plugin's marker and account. Comment edits are last-write-wins and are not treated as a concurrency check.
- The cache keeps whatever validator the adapter gives (ETag where the forge sends one, otherwise `updated_at` or `content_version`).

## Consequences

- LS-03 defines the `version` field in the `Forge` interface instead of an ETag.
- Gitea reads that need change detection poll `content_version` or `updated_at`.
