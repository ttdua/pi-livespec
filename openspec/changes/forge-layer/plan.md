# Forge Layer Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Provide a `Forge` interface with GitHub and Gitea adapters, markers, labels, a cache and read-only mode, proven by one contract suite.

**Architecture:** A small module per responsibility under `src/forge/`. Adapters implement `Forge`; `CachedForge` decorates any adapter. Concurrency is a per-adapter `Version` check, as in ADR 0007 and `design.md`. Tests use a fake `gh` script and a loopback fake Gitea.

**Tech Stack:** TypeScript (ESM, `.ts` imports), Node `fetch` and `node:http`, `gh` CLI, `yaml`, vitest, bun.

---

## Contracts

| Name | new / modified | Shape | public |
|---|---|---|---|
| `Version` | new | `string & { __brand: "Version" }`; `gh:<updatedAt>:<sha256>`, `cv:<n>`, `rc:<updatedAt>:<sha256>` | yes |
| `Issue` | new | `{ number; title; body; labels: string[]; state: "open"\|"closed"; author: string; updatedAt: string; version: Version; stale?: boolean }` | yes |
| `Comment` | new | `{ id: string; author: string; body: string; createdAt: string; updatedAt: string; version: Version }` | yes |
| `PullRequest` | new | `{ number; state; merged: boolean; mergedAt?: string; head: string; base: string; title; body; version: Version }` | yes |
| `Review` / `ReviewComment` / `CheckSummary` | new | `Review {author; state: "approved"\|"changes_requested"\|"commented"; body}`, `ReviewComment {path; line; body; author}`, `CheckSummary {state: "success"\|"failure"\|"pending"\|"none"; checks: {name; state; url?}[]}` | yes |
| `WriteResult<T extends {version: Version}>` | new | `{status:"written"; item: T; check:"strict"\|"best-effort"} \| {status:"conflict"; current: Version; changed: string[]}`; typed per entity (user decision) | yes |
| `ForgeError` | new | `class ForgeError extends Error { code: "unreachable"\|"auth"\|"http"\|"readonly"\|"unsupported"; operation: string; status?: number }` | yes |
| `Forge` | new | interface from issue #3 with `version` replacing the ETag; `updateIssueBody(n, body, expect: Version): Promise<WriteResult<Issue>>`; `updatePullRequest(n, patch: {title?; body?}, expect: Version): Promise<WriteResult<PullRequest>>` (user decision: matches fail-closed spec; sketch had no `expect`); `updateComment(id, body, expect: Version): Promise<WriteResult<Comment>>` (user decision: typed per entity) | yes |
| `registerKind` / marker API | new | `registerKind(name: string): void`; `writeMarked(kind, id, data): string`; `readMarkedComments(forge, issue): Promise<{comments: MarkedComment[]; warnings: string[]}>` | yes |
| `LabelRepo` (internal) | new | `{ listLabels(): Promise<string[]>; createLabel(name: string): Promise<void> }`; `ensureLabels(repo, labels)`. Adapters in Tasks 4 and 5 implement it; the public `Forge` interface stays unchanged (internal deviation from Task 2, kept to avoid widening the public contract) | no |
| Label constants | new | `LABEL_LIVESPEC="livespec"`, `phaseLabel(p)="livespec:phase/<p>"`, `LABEL_INITIATIVE`, `LABEL_PARKED` | yes |
| `CachedForge` | new | `new CachedForge(inner: Forge, opts: {cacheRoot?: string; host; owner; repo}): Forge` | yes |
| `detectForge` | new | `detectForge(repoRoot: string, deps?: {exec; fetch; env; readFile?; homedir?; platform?}): Promise<Forge>` | yes |
| `GitHubForgeOptions` | new | `{ghPath; repo; exec?; hostname?: string}`; `hostname` set => `--hostname <host>` on `gh auth status` and every `gh api` | yes |
| Cache file | new | `<cacheRoot>/<host>/<owner>/<repo>/<issue>.json` = `{issue; version; fetchedAt}` | no |

> Additive: `detectForge` deps gained optional `readFile, homedir, platform`; `GitHubForgeOptions` gained optional `hostname` (GitHub Enterprise; `detectForge` passes the origin host when it is not github.com).

---

## Task 1: Core types, errors, version helpers — implements 1

**Covers:** 1.1, 1.2, 1.3
**Difficulty:** Easy
**Blocked by:** none

Files: Create `src/forge/types.ts`, `src/forge/errors.ts`, `src/forge/version.ts`, `tests/forge/version.test.ts`.

- [ ] **Step 1:** Write failing tests: `bodyVersion` differs when body or updatedAt differs; `changedFields` returns `["body"]`; `ForgeError` carries `code`.
- [ ] **Step 2:** Run `bun run test tests/forge/version.test.ts`; expect FAIL (missing modules).
- [ ] **Step 3:** Implement the three modules per Contracts.
- [ ] **Step 4:** Run tests and `bun run typecheck`; expect PASS.
- [ ] **Step 5:** Commit `feat(forge): core types, errors and version helpers`.

---

## Task 2: Markers and labels — implements 2

**Covers:** 2.1, 2.2, 2.3
**Difficulty:** Normal
**Blocked by:** Task 1

Files: Create `src/forge/markers.ts`, `src/forge/labels.ts`, `tests/forge/markers.test.ts`, `tests/forge/labels.test.ts`.

- [ ] **Step 1:** Write failing tests for marker round trip, unknown kind rejection, `registerKind`, foreign marked comment ignored with warning, plain comment ignored, label constants, `ensureLabels` creating only missing labels (against a stub forge).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `writeMarked`, parser (first line regex plus fenced yaml via `yaml`), `readMarkedComments`, label helpers.
- [ ] **Step 4:** Run tests and typecheck; expect PASS.
- [ ] **Step 5:** Commit `feat(forge): comment markers and labels`.

---

## Task 3: Contract suite harness — implements 3

**Covers:** 3.1, 3.2
**Difficulty:** Hard
**Blocked by:** Task 1, Task 2

Files: Create `tests/forge/contract.ts`, `tests/forge/world.ts`.

- [ ] **Step 1:** Define `ContractWorld` (`forge`, `seedIssue`, `editBodyBehindBack`, `postComment(author)`, `dropLabel`, `unreachable()`).
- [ ] **Step 2:** Write `runContract(name, makeWorld)` with one `it` per scenario of `forge-interface`, `forge-markers`, and the operation-coverage scenarios of both adapter specs.
- [ ] **Step 3:** Typecheck; the file has no runner yet (adapters call it).
- [ ] **Step 4:** Commit `test(forge): shared contract suite harness`.

---

## Task 4: GitHub adapter — implements 4

**Covers:** 4.1, 4.2, 4.3
**Difficulty:** Hard
**Blocked by:** Task 3

Files: Create `tests/forge/fake-gh/gh` (node script, state file in `$FAKE_GH_STATE`), `tests/forge/github.test.ts`, `src/forge/github.ts`.

- [ ] **Step 1:** Write the fake `gh` supporting `auth status`, `api <route> [-X] [-f/-F/--input]` for the routes used.
- [ ] **Step 2:** Write `github.test.ts` calling `runContract` plus GitHub-only tests (`auth status` failure gives `auth`; no PATCH when changed).
- [ ] **Step 3:** Run; expect FAIL.
- [ ] **Step 4:** Implement `GitHubForge` with an injected `gh` path and `exec`; map spawn errors and network errors to `unreachable`, non-zero HTTP to `http`.
- [ ] **Step 5:** Implement the re-read, compare, PATCH write; run tests, typecheck; expect PASS.
- [ ] **Step 6:** Commit `feat(forge): GitHub adapter`.

---

## Task 5: Gitea adapter — implements 5

**Covers:** 5.1, 5.2, 5.3
**Difficulty:** Hard
**Blocked by:** Task 3

Files: Create `tests/forge/fake-gitea.ts`, `tests/forge/gitea.test.ts`, `src/forge/gitea.ts`.

- [ ] **Step 1:** Write the fake server (`node:http`) with probe (g) behavior: `content_version` increments, 409 on stale, no ETag, label and status endpoints; option `withContentVersion: false`.
- [ ] **Step 2:** Write `gitea.test.ts`: `runContract` in both modes plus token tests (env, `tea` config file, none) and 409 mapping.
- [ ] **Step 3:** Run; expect FAIL.
- [ ] **Step 4:** Implement `GiteaForge` with injected `fetch`, `env`, `teaConfigPath`; fetch rejects map to `unreachable`.
- [ ] **Step 5:** Implement `content_version` write and re-read fallback; run tests, typecheck; expect PASS.
- [ ] **Step 6:** Commit `feat(forge): Gitea adapter`.

---

## Task 6: Cache and read-only mode — implements 6

**Covers:** 6.1, 6.2
**Difficulty:** Normal
**Blocked by:** Task 1

Files: Create `src/forge/cache.ts`, `tests/forge/cache.test.ts`.

- [ ] **Step 1:** Write failing tests with a stub inner `Forge` and a temp `cacheRoot`: write-through file layout, deleted cache refetch, unreachable read returns `stale: true`, unreachable write gives `readonly`, uncached unreachable read gives `unreachable`, HTTP 404 does not enter read-only, recovery after a good read.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `CachedForge` as a decorator with a `readonly` flag.
- [ ] **Step 4:** Run tests, typecheck; expect PASS.
- [ ] **Step 5:** Commit `feat(forge): cache and read-only mode`.

---

## Task 7: Forge detection — implements 7

**Covers:** 7.1, 7.2
**Difficulty:** Normal
**Blocked by:** Task 4, Task 5

Files: Create `src/forge/detect.ts`, `src/forge/index.ts`, `tests/forge/detect.test.ts`.

- [ ] **Step 1:** Write failing tests with an injected `git remote get-url origin` result, config file, and fake probe: `github.com`, configured Enterprise host, config Gitea, probe Gitea, unknown host gives `unsupported`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `detectForge` and the `index.ts` exports.
- [ ] **Step 4:** Run tests, typecheck; expect PASS.
- [ ] **Step 5:** Commit `feat(forge): detection and public exports`.

---

## Task 8: Docs and smoke run — implements 8

**Covers:** 8.1, 8.2, 8.3
**Difficulty:** Easy
**Blocked by:** Task 6, Task 7

Files: Modify `docs/architecture.md`; Create `openspec/changes/forge-layer/smoke.md`.

- [ ] **Step 1:** Edit `docs/architecture.md`: forge row says "cache with version"; mention ADR 0007.
- [ ] **Step 2:** Run the smoke script (create, edit with stale and current version, comment, label, PR read) against one real GitHub repo and one real Gitea repo; record commands, results and the Gitea release in `smoke.md`.
- [ ] **Step 3:** Run `bun run typecheck && bun run test`; expect all PASS.
- [ ] **Step 4:** Commit `docs(forge): architecture update and smoke record`.

---

## Scenario → test

- Both adapters implement the interface → `tests/forge/github.test.ts`, `gitea.test.ts` (`runContract`)
- Version is returned on read → contract `getIssue has version`
- Stale issue body edit → contract `stale body edit gives conflict`
- Current version edit → contract `current version edit is written`
- Auth failure → `github.test.ts` auth, `gitea.test.ts` no token
- No version gate → `gitea.test.ts` fallback mode writes succeed
- GitHub remote / Gitea by config / Gitea by probe / Unknown host → `tests/forge/detect.test.ts`
- Offline run → whole suite runs on loopback only (`bun run test`)
- Written comment shape / Round trip / Registered kind / Unknown kind → `tests/forge/markers.test.ts`
- Foreign marked comment / Own marked comment / Plain comment → `markers.test.ts` and contract `foreign marker ignored`
- Edit a foreign comment → contract `foreign comment edit refused`
- Missing label is created / Existing label → `labels.test.ts` and contract `missing label created`
- Read writes through / Cache deleted → `cache.test.ts`
- Unreachable read / write / Not cached / HTTP error / Recovery → `cache.test.ts`
- Not logged in / Identity → `github.test.ts`
- Changed since read / Unchanged → `github.test.ts` and contract
- Pull request flow / Checks summary → contract PR and checks tests (GitHub)
- Token from environment / tea config / No token → `gitea.test.ts`
- Stale content_version / Current content_version → `gitea.test.ts` (content_version mode)
- Older server / Older server, changed body → `gitea.test.ts` (fallback mode)
- Comments / Labels / Checks from statuses → contract tests (Gitea)
