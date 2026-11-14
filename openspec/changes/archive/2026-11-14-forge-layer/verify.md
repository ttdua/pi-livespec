# Verification Report

**Change**: `forge-layer`
**Verified at**: `2026-11-14 17:10`
**Iteration**: `1`
**Verifier**: `parent session, inline (no agent meets the verifier role in the agent list; every check was run by the parent in this invocation)`

---

## 1. Structural Validation (`openspec validate forge-layer`)

- [x] The command passes for this change

**Result**:

```text
Change 'forge-layer' is valid
exit 0
```

---

## 2. Task Completion (`tasks.md`)

- [x] Every box is ticked, or each open box has a recorded reason

`grep -c '^- \[x\]'` = 21, `grep -c '^- \[ \]'` = 0. `openspec instructions apply` reports `progress: 21/21`, `state: all_done`.

| Open task | Reason | Blocks archive? |
|---|---|---|
| none | | |

---

## 3. Requirement Evidence

- [x] ADDED / MODIFIED: implementation evidence (file / line)
- [x] REMOVED: not applicable (the change has no REMOVED section)
- [x] RENAMED: not applicable (no RENAMED section)

All 20 requirements across the five delta specs are ADDED. No main spec exists for these capabilities, and `package-scaffold` and `host-seam-evidence` are not touched.

| Requirement | Operation | Status | Evidence (file:line) |
|---|---|---|---|
| forge-interface: Forge interface | ADDED | Pass | `src/forge/types.ts:100-133` (`Forge`, every entity has `version`); `GitHubForge` `src/forge/github.ts`, `GiteaForge` `src/forge/gitea.ts` |
| forge-interface: Fail-closed body writes | ADDED | Pass | GitHub `src/forge/github.ts:199` (`updateIssueBody`), `:298` (`updatePullRequest`); Gitea `src/forge/gitea.ts:107`, `:211`; `WriteResult` `src/forge/types.ts:92-94` |
| forge-interface: Failures are thrown, not blocked by server version | ADDED | Pass | `src/forge/errors.ts:1-17` (`ForgeErrorCode`); Gitea decides per response (`src/forge/gitea.ts:289-306`), no version gate |
| forge-interface: Forge detection | ADDED | Pass | `src/forge/detect.ts:69` (`detectForge`), `:73`, `:97` (`unsupported`) |
| forge-interface: Shared contract suite | ADDED | Pass | `tests/forge/contract.ts:18` run by `github.test.ts`, `gitea.test.ts` (two modes), `contract.selftest.test.ts` |
| forge-markers: Comment marker format | ADDED | Pass | `src/forge/markers.ts:59` (`writeMarked`) |
| forge-markers: Core kinds and registration | ADDED | Pass | `src/forge/markers.ts:23` (`CORE_KINDS`, 10 kinds), `:36`, `:48` (`registerKind`) |
| forge-markers: Only own marked comments count | ADDED | Pass | `src/forge/markers.ts:94` (`readMarkedComments`) |
| forge-markers: Own-marker comment edits | ADDED | Pass | `src/forge/markers.ts:120` (`assertOwnMarkedComment`), called from `src/forge/github.ts:259` and `src/forge/gitea.ts:169` |
| forge-markers: Labels | ADDED | Pass | `src/forge/labels.ts:8` (`phaseLabel`), `:19` (`ensureLabels`); adapters implement `LabelRepo` (`src/forge/gitea.ts:143`, `:148`) |
| forge-cache: Issue cache | ADDED | Pass | `src/forge/cache.ts:31`, `:94` (`cacheDir`), write-through in `getIssue` |
| forge-cache: Read-only mode | ADDED | Pass | `src/forge/cache.ts:74` (`readonly`), `:127` (`stale: true`) |
| forge-cache: Read-only mode only for unreachability | ADDED | Pass | `src/forge/cache.ts` (`enterOnUnreachable` only for `unreachable`; reads clear it, writes never do) |
| github-adapter: GitHub transport and auth | ADDED | Pass | `src/forge/github.ts:387` (`gh auth status`), `--hostname` at `:159` |
| github-adapter: GitHub body version and re-read check | ADDED | Pass | `src/forge/github.ts:349`, `:365` (`bodyVersion(..., "gh")`), re-read in `updateIssueBody` `:199` |
| github-adapter: GitHub operation coverage | ADDED | Pass | `src/forge/github.ts` (PRs, reviews, review comments), `getChecks` at `:323` |
| gitea-adapter: Gitea transport and auth | ADDED | Pass | `src/forge/tea-config.ts:1-19` (`GITEA_TOKEN`, then tea config, never spawns tea), `src/forge/gitea-transport.ts` (built-in `fetch`) |
| gitea-adapter: Gitea version from content_version when present | ADDED | Pass | `src/forge/gitea.ts:289-306` (sends `content_version`, 409 to conflict) |
| gitea-adapter: Fallback when content_version is absent | ADDED | Pass | `src/forge/gitea.ts:289-306`, `bodyVersion(..., "rc")`, `check: "best-effort"` |
| gitea-adapter: Gitea operation coverage | ADDED | Pass | `src/forge/gitea.ts:169` (comments), `:143`, `:148` (labels), `:248` (`getChecks` from statuses) |

Real-forge evidence also exists in `smoke.md` (GitHub and Gitea 1.27.3, run twice).

---

## 4. Scenario Coverage

- [x] Every scenario maps to a test (45 of 45)
- [x] The project test command was run fresh in this step

**Test command**: `bun run test` (in `/Users/naicoi/Projects/oss/pi-livespec.forge-layer`)
**Result**: exit 0, 15 test files passed, 404 tests passed, 0 failed. `bun run typecheck`: exit 0. The same run with a minimal environment (`env -i`, no proxy or tokens) also passed 404/404.

"Offline run": every test uses an injected `exec` or `fetch`, a loopback server, or a nonexistent binary; no test reaches an external host.

| Scenario | Test |
|---|---|
| forge-cache: Read writes through | `tests/forge/cache.test.ts:72` |
| forge-cache: Cache deleted | `cache.test.ts:87` |
| forge-cache: Unreachable read | `cache.test.ts:105` |
| forge-cache: Unreachable write | `cache.test.ts:117`, `:182` |
| forge-cache: Not cached | `cache.test.ts:135` |
| forge-cache: HTTP error | `cache.test.ts:143`, `:206` |
| forge-cache: Recovery | `cache.test.ts:155`, `:169` |
| forge-interface: Both adapters implement the interface | `contract.ts` run in `github.test.ts`, `gitea.test.ts` (cv and no-cv) and `contract.selftest.test.ts` |
| forge-interface: Version is returned on read | `contract.ts:39` |
| forge-interface: Stale issue body edit | `contract.ts:81` |
| forge-interface: Current version edit | `contract.ts:95` |
| forge-interface: Auth failure | `github.test.ts:26`, `gitea.test.ts:71`, `:86`, `:97` |
| forge-interface: No version gate | `gitea.test.ts:169-196` (older server writes succeed, no version endpoint is called) |
| forge-interface: GitHub remote | `detect.test.ts:61` |
| forge-interface: Gitea by config | `detect.test.ts:138` |
| forge-interface: Gitea by probe | `detect.test.ts:149` |
| forge-interface: Unknown host | `detect.test.ts:157` |
| forge-interface: Offline run | whole suite; the `env -i` run above |
| forge-markers: Written comment shape | `tests/forge/markers.test.ts:27` |
| forge-markers: Round trip | `markers.test.ts:62`, `:74` |
| forge-markers: Registered kind | `markers.test.ts:82` |
| forge-markers: Unknown kind | `markers.test.ts:35` |
| forge-markers: Foreign marked comment | `markers.test.ts:119`, `contract.ts:233` |
| forge-markers: Own marked comment | `markers.test.ts:110`, `contract.ts:245` |
| forge-markers: Plain comment | `markers.test.ts:127`, `contract.ts:258` |
| forge-markers: Edit a foreign comment | `contract.ts:269`, `gitea.test.ts:206`, `markers.test.ts:141` |
| forge-markers: Edit an unmarked own comment | `contract.ts:282`, `gitea.test.ts:218`, `markers.test.ts:147` |
| forge-markers: Missing label is created | `contract.ts:140`, `labels.test.ts:32` |
| forge-markers: Existing label | `contract.ts:165`, `labels.test.ts:38` |
| gitea-adapter: Token from environment | `gitea.test.ts:48` |
| gitea-adapter: Token from tea config | `gitea.test.ts:55` (asserts no process spawned), `:444-496` |
| gitea-adapter: No token | `gitea.test.ts:71` |
| gitea-adapter: Stale content_version | `gitea.test.ts:111` |
| gitea-adapter: Current content_version | `gitea.test.ts:158` |
| gitea-adapter: Older server | `gitea.test.ts:170` |
| gitea-adapter: Older server, changed body | `gitea.test.ts:183` |
| gitea-adapter: Comments | `contract.ts:180` (Gitea runs) |
| gitea-adapter: Labels | `contract.ts:140`, `:152` (Gitea fake counts label creates) |
| gitea-adapter: Checks from statuses | `contract.ts:414-432`, `gitea.test.ts:260`, `:291` |
| github-adapter: Not logged in | `github.test.ts:26` |
| github-adapter: Identity | `github.test.ts:67` |
| github-adapter: Changed since read | `github.test.ts:73` |
| github-adapter: Unchanged | `github.test.ts:85` (one PATCH, `best-effort`) |
| github-adapter: Pull request flow | `contract.ts:302` (GitHub runs) |
| github-adapter: Checks summary | `contract.ts:414-432`, `github.test.ts:116`, `:128` |

---

## 5. Design and Contract Coherence (warning only)

- [x] Decisions in design.md match the code
- [x] Contracts in plan.md, with the Contract deviations recorded in apply.md, match the code

Compared read-only (`plan.md` Contracts, `apply.md` deviations, `src/forge/types.ts`, `src/forge/index.ts`, adapters):

| Contract entry | Result |
|---|---|
| `Version`, `Issue`, `Comment`, `PullRequest`, `Review`/`ReviewComment`/`CheckSummary`, `ForgeError` | Matched (`src/forge/types.ts`, `src/forge/errors.ts`) |
| `WriteResult<T>` (typed, user decision) | Matched (`src/forge/types.ts:92`) |
| `Forge` incl. `updatePullRequest(..., expect)` and typed results | Matched (`src/forge/types.ts:100-133`) |
| marker API, label constants | Matched (`markers.ts:48,59,94`; `labels.ts`) |
| `LabelRepo` (internal) | Matched; not in the barrel, as recorded |
| `CachedForge`, `isReadOnly()`, cache file | Matched (`src/forge/cache.ts`) |
| `detectForge` with optional extra deps | Matched (`src/forge/detect.ts:69`) |
| `GitHubForgeOptions.hostname` | Matched (`src/forge/github.ts:44-45,159`) |
| `ExecFn` / `ExecResult` | Matched, exported from the barrel (`src/forge/index.ts`) |
| `GiteaOptions` incl. `timeoutMs` | Matched (`src/forge/gitea.ts`) |
| `apply.md` deviations (error mapping, GitHub `best-effort`, own-marker enforcement) | Matched in code, design.md and specs |

**Drift warnings** (non-blocking):

- `createExec({timeoutMs})` and `DEFAULT_GH_TIMEOUT_MS` are exported from `src/forge/github.ts` but have no row in the plan Contracts and are not in the barrel. The ExecFn row mentions the 60 s default. The `apply.md` deviations list records them. Suggestion: add a Contracts row or keep them module-private.
- `design.md` was edited to say 401 and 403 are `auth`, except a rate-limit 403; the code follows it, but the spec files carry no scenario for rate-limit handling. The behavior is covered by `github.test.ts:304-309`.
- `smoke.md` is an extra artifact (the `Done when` of issue #3 asks for a recorded smoke run); it is not in the schema's artifact list, so it travels only with the change directory.

---

## 6. Clean Tree and Commit Range

- [x] Working tree is clean

`git status --porcelain` printed nothing before this receipt was written.

**Commit range**: `7283ed5..a47a057` (41 commits, including the apply receipt; the scaffold commit of the change directory is `7283ed5`, the change code starts after it). Code range recorded in `apply.md`: `7283ed5..378f124`.

---

## Overall Decision

- [ ] PASS: proceed with `/opsx-continue` to finalize
- [x] PASS_WITH_WARNINGS: proceed, noting: three non-blocking drift warnings in section 5 (`createExec` has no Contracts row, rate-limit rule has no spec scenario, `smoke.md` outside the artifact list). No CRITICAL issues; fresh tests green (404/404); every check run in this invocation.
- [ ] FAIL: fix the cause, then re-apply (iteration N+1)

**Issues**

- CRITICAL: none.
- WARNING:
  1. `createExec` and `DEFAULT_GH_TIMEOUT_MS` are public exports of `src/forge/github.ts` without a Contracts row. Recommendation: add a row in `plan.md` Contracts (or make them module-private) before `/opsx-archive`.
  2. GitHub Enterprise `--hostname` was only exercised against the fake `gh` (`apply.md` known limit; `smoke.md` "Not covered"). Recommendation: smoke it on a real GHE host when one is available.
- SUGGESTION:
  1. Add a spec scenario for the rate-limit 403 rule so it is covered by the delta spec, not only by `design.md`.
  2. Merge the duplicated `overallState`-style helpers is done (`src/forge/mapping.ts`); consider a short note in `design.md` for where the shared pure helpers live (already listed in the module list).

**Next step**:

Run `/opsx-continue` with `/Users/naicoi/Projects/oss/pi-livespec.forge-layer` as the working directory to create the finalize artifact, then `/opsx-archive`. Pushing and opening a PR need your explicit go-ahead.
