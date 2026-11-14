# 0002: The forge issue is the source of truth for a change

Status: Accepted (2026-11-13), refined by [0007](0007-forge-concurrency-by-adapter.md)

## Context

Work in progress needs to survive sessions and compaction, and the team should see progress where it already works. A local change folder mirrored to an issue would need two-way sync.

## Decision

- A change is a forge issue. Its body holds ownership lines, capabilities, proposal, design, questions, units and the durable docs table.
- Tool-written comments with machine-readable markers hold receipts, gate decisions, amendments, counters and decision records.
- Each change has one branch and ships as exactly one pull request that references the issue. A human merges; a tool then closes the issue with a summary.
- Large work is an initiative: a tracking issue that lists change issues and their dependencies.
- GitHub and Gitea are supported first, behind a `Forge` interface.
- The local copy is only a cache with ETags. Writes fail closed when the issue changed since it was read.

## Consequences

- The flow needs network access. When the forge is unreachable, tools read from the cache and refuse writes.
- There is no archive folder in the repository; history is the closed issue plus its pull request.
- Offline mode is deferred to after v1.
