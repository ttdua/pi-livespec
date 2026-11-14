## Context

`src/` holds only the extension entry and `version.ts` (LS-01). Probe (g) in `docs/evidence/host-seams.md` showed Gitea 28.3.0 has `content_version` on issue and PR edits (409 when stale), no ETag, and no version on comment edits. GitHub's REST API has no conditional write. ADR 0007 fixes the interface shape; this design settles the GitHub mechanism and the behavior on servers without `content_version`.

## Goals / Non-Goals

**Goals:**
- One `Forge` interface that hides transport, auth and concurrency details.
- Writes fail closed when the body changed since the caller read it.
- Adapters testable with no network beyond loopback.

**Non-Goals:**
- Write permissions policy (LS-06) and issue body parsing (LS-02).
- Offline mode beyond stale reads (deferred after v1, ADR 0002).
- SDKs, `tea` command execution, git hooks.

## Decisions

**Opaque `Version` string.** `Version` is a branded string; callers only pass back what they read. Reason: ADR 0007; adapters may change the scheme. GitHub: `gh:<updatedAt>:<sha256(body)>`. Gitea with field: `cv:<content_version>`. Gitea without: `rc:<updatedAt>:<sha256(body)>`.

**GitHub check = re-read, compare, PATCH.** Reason: no server-side check exists. The remaining window is milliseconds, versus the minutes between a caller's read and write. A lock comment was rejected: extra writes, stale locks, and humans can still edit.

**Gitea capability is detected per response, never by version number.** If the issue JSON has `content_version`, send it and map 409 to conflict. If absent, use the GitHub-style re-read check and return `check: "best-effort"` in `WriteResult`. Nothing is blocked because of server version; only a real failed call blocks. Reason: user feedback; avoids guessing a minimum version. Gitea releases that have the field are noted in the smoke record for information only.

**Write result is a union, typed per entity, errors are thrown.** `WriteResult<T> = {status:"written", item: T, check:"strict"|"best-effort"} | {status:"conflict", current: Version, changed: string[]}`, with `T` = `Issue`, `Comment` or `PullRequest` per edit method (user decision). `written.item` is the entity after the write. Transport, auth and HTTP failures throw `ForgeError` with `code` in `unreachable | auth | http | readonly | unsupported`. Reason: a conflict is an expected outcome the engine handles; the rest are failures.

**Comments are last-write-wins.** `updateComment` takes a `Version` (updated-at hash) and re-reads on both forges, best-effort, but the check that matters is ownership: the plugin edits only comments carrying its marker and account.

**Markers.** First line `<!-- livespec:{kind}:{id} -->`, then one fenced `yaml` block. Parsed with the existing `yaml` package. `readMarkedComments` filters by `whoami().login` and returns `{comments, warnings}`; foreign marked comments become warnings. `registerKind(name)` extends the core kind set; unknown kinds are rejected on write.

**Cache and read-only wrapper.** `CachedForge` decorates any `Forge`. Reads write through to `<root>/<host>/<owner>/<repo>/<issue>.json` holding `{issue, version, fetchedAt}`. On an `unreachable` failure it enters read-only mode: reads return the cached issue with `stale: true`, writes throw `ForgeError("readonly")` with a clear message. A later successful read leaves read-only mode. HTTP 4xx/5xx errors do not trigger read-only mode.

**Detection.** `detectForge(repoRoot, deps)` reads the `origin` remote and optional `.pi/livespec/config.yaml`: `github.com` or a configured GitHub Enterprise host gives GitHub; config `forge: gitea` plus host, or a successful `/api/v1/version` probe, gives Gitea. Gitea token comes from `GITEA_TOKEN` or the `tea` config file (read, never executed).

**Testing.** `tests/forge/contract.ts` exports `runContract(factory)`. GitHub runs it against a fake `gh` executable (a Node script on `PATH` backed by in-memory state); Gitea against a loopback `http` server. Config for the cache root and the fake `gh` path is injected, so no real home directory or network is touched.

## Risks / Trade-offs

- [GitHub re-read window] → accepted, documented, covered by the `check` field; the caller always compares against its own read.
- [Fake servers drift from real APIs] → manual smoke run per forge recorded in the change; probe (g) facts encoded in the fake.
- [Gitea without `content_version` is best-effort] → `WriteResult<T>.check` makes it visible; no block.
- [`gh` output format changes] → use `gh api` JSON only, never human-readable output.
- [Large module] → split by responsibility: `types`, `errors`, `markers`, `labels`, `cache`, `github`, `gitea`, `detect`.

## Open Questions

- Which Gitea releases carry `content_version`? Recorded for information in the smoke record; not a gate.
