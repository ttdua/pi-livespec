## 1. Core types, errors and version helpers

Blocked by: none

- [x] 1.1 Define `Forge`, `Issue`, `Comment`, `PullRequest`, `Review`, `ReviewComment`, `CheckSummary`, `Version`, `WriteResult` in `src/forge/types.ts`
- [x] 1.2 Add `ForgeError` with codes `unreachable | auth | http | readonly | unsupported` in `src/forge/errors.ts`
- [x] 1.3 Add `bodyVersion(updatedAt, body)` hashing and `changedFields(a, b)` in `src/forge/version.ts`

## 2. Markers and labels

Blocked by: 1

- [x] 2.1 Implement marker write/parse and `registerKind` in `src/forge/markers.ts`
- [x] 2.2 Implement `readMarkedComments` with account filtering and warnings
- [x] 2.3 Add label constants and `ensureLabels` helper in `src/forge/labels.ts`

## 3. Contract suite harness

Blocked by: 1, 2

- [x] 3.1 Write `runContract(factory)` in `tests/forge/contract.ts` covering issues, labels, comments, PRs, reviews, checks, conflict, foreign marker and missing label scenarios
- [x] 3.2 Define the `ContractWorld` interface (mutate-behind-the-back hooks) that each fake implements

## 4. GitHub adapter

Blocked by: 3

- [ ] 4.1 Build a fake `gh` executable and state in `tests/forge/fake-gh/`
- [ ] 4.2 Implement `GitHubForge` in `src/forge/github.ts` (auth, whoami, issues, labels, comments, PRs, reviews, checks)
- [ ] 4.3 Implement the re-read and compare body write; wire `runContract` for GitHub

## 5. Gitea adapter

Blocked by: 3

- [ ] 5.1 Build a loopback fake Gitea server in `tests/forge/fake-gitea.ts` with `content_version` on and off modes
- [ ] 5.2 Implement `GiteaForge` in `src/forge/gitea.ts` (token lookup, REST calls, operations)
- [ ] 5.3 Implement `content_version` writes with 409 mapping and the re-read fallback; wire `runContract` for Gitea

## 6. Cache and read-only mode

Blocked by: 1

- [x] 6.1 Implement `CachedForge` decorator and cache file layout in `src/forge/cache.ts`
- [x] 6.2 Implement read-only mode entry and exit rules and tests

## 7. Forge detection

Blocked by: 4, 5

- [ ] 7.1 Implement `detectForge` in `src/forge/detect.ts` and the public export in `src/forge/index.ts`
- [ ] 7.2 Tests for GitHub host, Enterprise host, config Gitea, probe and unknown host

## 8. Docs and smoke run

Blocked by: 6, 7

- [ ] 8.1 Update the forge row and ETag wording in `docs/architecture.md`
- [ ] 8.2 Run a manual smoke run against one real GitHub and one real Gitea repository and record it in `openspec/changes/forge-layer/smoke.md`
- [ ] 8.3 Run `bun run typecheck` and `bun run test`
