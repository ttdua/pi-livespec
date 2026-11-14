## Why

The forge issue is the source of truth for a change (ADR 0002), and every later spec reads and writes issues, comments and pull requests. Without one tested interface, forge details would leak into the engine and each adapter would invent its own concurrency rules. LS-04 to LS-09 depend on this layer.

## What Changes

- Add a `Forge` interface with an opaque `version` on issue, pull request and comment bodies (ADR 0007).
- Add a GitHub adapter (`gh api`) and a Gitea adapter (REST through `fetch`), plus forge detection and authentication checks.
- Add machine-readable comment markers, label constants with create-on-demand, and `registerKind`.
- Add a local issue cache and a read-only mode used when the forge cannot be reached.
- Add one contract test suite run against both adapters with a fake `gh` and a loopback fake Gitea.

**Concurrency check**
- From: ADR 0002 said the cache keeps ETags and writes fail closed on ETag mismatch.
- To: each adapter checks `version`: GitHub re-reads and compares before writing; Gitea uses `content_version` when the response has it, otherwise the same re-read check (best-effort). A real failed call blocks; server version never does.
- Reason: probe (g) showed Gitea sends no ETag; GitHub does not support conditional writes.
- Impact: non-breaking; implements ADR 0007 and adds no new decision to the ADR.

Out of scope: who may call writes (LS-06 guards) and what issue bodies mean (LS-02).

## Capabilities

### New Capabilities
- `forge-interface`: the `Forge` contract, `version`, `WriteResult`, error model, detection and the shared contract test suite.
- `forge-markers`: comment marker format, marked-comment reading by account, kinds registry and label conventions.
- `forge-cache`: on-disk issue cache and read-only mode.
- `github-adapter`: GitHub implementation through the `gh` CLI.
- `gitea-adapter`: Gitea implementation through REST.

### Modified Capabilities

None. The living specs `package-scaffold` and `host-seam-evidence` keep their requirements.

## Impact

- New code under `src/forge/`, new tests under `tests/forge/`.
- No new runtime dependency (`yaml` is already present); Gitea uses Node's `fetch`, GitHub uses the `gh` executable.
- `docs/architecture.md` forge row is updated from "cache with ETag" to "cache with version".
- A manual smoke run against one real repository per forge is recorded in the change.
