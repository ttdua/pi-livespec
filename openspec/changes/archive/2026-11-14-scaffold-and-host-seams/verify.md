# Verification Report

**Change**: `scaffold-and-host-seams`
**Verified at**: `2026-11-13 23:10`
**Iteration**: `1`
**Verifier**: `parent session (inline; no agent met the verifier role)`

---

## 1. Structural Validation (`openspec validate scaffold-and-host-seams`)

- [x] The command passes for this change

**Result**:

```text
Change 'scaffold-and-host-seams' is valid   (exit 0)
```

---

## 2. Task Completion (`tasks.md`)

- [x] Every box is ticked, or each open box has a recorded reason

14 of 14 boxes are `[x]`, 0 are `[ ]` (`grep -c` on `tasks.md`; `openspec instructions apply` reports 14/14).

| Open task | Reason | Blocks archive? |
|---|---|---|
| — | — | — |

---

## 3. Requirement Evidence

- [x] ADDED / MODIFIED: implementation evidence (file / line)
- [x] REMOVED: not applicable (no REMOVED requirements)
- [x] RENAMED: not applicable (no RENAMED requirements)

| Requirement | Operation | Status | Evidence (file:line) or reason |
|---|---|---|---|
| package-scaffold: Loadable pi package | ADDED | Pass | `package.json:14-18` (`pi.extensions`); loaded in a fresh pi run through both `-e` and the package path in settings, `/livespec` answered |
| package-scaffold: Dependency policy | ADDED | Pass | `package.json:26-31` (peer `*`, `yaml` only) |
| package-scaffold: Version command | ADDED | Pass | `src/extension.ts:5-12`, `src/version.ts:5-9`; fresh pi run printed `pi-livespec 0.0.0` |
| package-scaffold: CI gate | ADDED | Pass for the file, Not verified for a run | `.github/workflows/ci.yml:4-5,14-15`; the workflow has not run on GitHub (nothing pushed); the same commands ran locally |
| host-seam-evidence: Evidence document with one section per probe | ADDED | Pass with a gap | `docs/evidence/host-seams.md:11,32,51,82,103,133,160,192,211,230` (ten sections, each with Question, Method, Result, Consequence, Fallback). Gap: the pi version is stated once in the intro (line 5), not inside each Method |
| host-seam-evidence: Fallback for failed or unverified probes | ADDED | Pass | ten `### Fallback` sections; no probe is Unverified (`grep Unverified` finds only the rule in the test) |
| host-seam-evidence: Decisions follow the evidence | ADDED | Pass | `docs/decisions/0007-forge-concurrency-by-adapter.md`, README row, ADR 0002 status line |
| host-seam-evidence: No kept probe code | ADDED | Pass | `src/` holds only `extension.ts` and `version.ts`; `rg -i probe src` finds 0 hits; no scratch files in the tree |
| host-seam-evidence: Probes do not alter the user's pi configuration | ADDED | Pass for the files, with an incident | `settings.json` and `auth.json` md5 equal the values taken before the probes; the real `auth.json` was read and a copy printed once (see `apply.md` incident) |

---

## 4. Scenario Coverage

- [x] Every scenario maps to a test or a recorded manual check
- [x] The project test command was run fresh in this step

**Test command**: `bun run test` (`vitest run`), plus `bun run typecheck` (`tsc --noEmit`), both in the worktree
**Result**: `4 test files passed, 22 tests passed, 0 failed; tsc exit 0`

| Scenario | Test |
|---|---|
| Pi loads the extension | `tests/extension.test.ts` ("registers the livespec command") and a manual fresh pi run this step |
| Manifest names a real entry point | `tests/manifest.test.ts` ("names real extension entry points") |
| Peer dependency range | `tests/manifest.test.ts` ("declares the pi peer dependency with range *") |
| Runtime dependencies | `tests/manifest.test.ts` ("has yaml as the only runtime dependency") |
| Command prints the version | `tests/extension.test.ts` ("prints the package version…"), `tests/version.test.ts` |
| Command has no side effects | `tests/extension.test.ts` (one `sendMessage`, no `notify`); weak: it does not check files or forge state |
| Workflow triggers | `tests/manifest.test.ts` ("triggers on push and pull_request…") |
| Failing check blocks | Not covered by a test or a run: the plan's throwaway failing branch (Task 1 Step 8) was not done; `Not verified` |
| All probes present | `tests/evidence.test.ts` ("has one section per probe a to j, in order") |
| Section content | `tests/evidence.test.ts` ("probe %s has Question, Method, Result, Consequence and Fallback") |
| Failed probe | `tests/evidence.test.ts` ("names a fallback for every probe") |
| Unverifiable probe | `tests/evidence.test.ts` ("marks an unverified probe…"); vacuous now, no probe is unverified |
| Fallback changes a decision | `tests/evidence.test.ts` ("lists every ADR file…", "links every Superseded status…") |
| Source tree is clean | Manual check this step (`rg -i probe src` = 0, `ls src`); no automated test |
| Real config untouched | Manual md5 check this step; no automated test |

---

## 5. Design and Contract Coherence (warning only)

- [x] Decisions in design.md match the code, with the drift below
- [x] Contracts in plan.md, with the Contract deviations recorded in apply.md, match the code, with the drift below

**Drift warnings** (non-blocking):

- `readVersion` contract: plan.md says `readVersion(packageJsonPath?: string): string`; code is `readVersion(packageJsonPath: URL | string = defaultPackageJson)` at `src/version.ts:5`. The deviation is not recorded in `apply.md`. Internal contract.
- design.md says the evidence keeps "short snippets where needed" and the plan says the same; the evidence has no code snippets (0 code fences). The spec only allows them.
- design.md says each Method records versions of the tools; the pi version is only in the document intro, and executor versions for (e) and Gitea for (g) are present in their sections. Other sections give no version.
- design.md says tooling uses `bun` with `bun.lock`: matches (`bun.lock` committed, CI uses `oven-sh/setup-bun@v2`).
- design.md says "probe (c) compares ... against a control run on both models": matches (four runs in the table).
- Not verified: Contract `CI workflow` runs `bun run typecheck` and `bun run test` on a GitHub runner; only the file content and a local run were checked.
- Not verified: Contract `Evidence document` says `Unverified: <reason>` under Result; no probe is unverified, so the format is only exercised by the test rule, not by a document.
- `apply.md` says "6 commits"-style counts may drift: it records `ac75d86..96b5575` with count 5 and a later receipt fix `7efe636`; the real range at verify is `ac75d86..7efe636` (6 commits).

---

## 6. Clean Tree and Commit Range

- [x] Working tree is clean (`git status --porcelain` printed 0 lines before this file was written)

**Commit range**: `ac75d86..7efe636` (6 commits: `e2e5ddb`, `ef4216d`, `22ea56c`, `09b1e00`, `96b5575`, `7efe636`)

---

## Overall Decision

- [ ] PASS
- [x] PASS_WITH_WARNINGS: proceed, noting: tests, typecheck, validation and tasks are green, but two checks are Not verified (the CI workflow has not run on GitHub; a failing check was never shown to fail the workflow), and the drift warnings above exist.
- [ ] FAIL

**Issues**

CRITICAL: none.

WARNING:
1. CI never ran on GitHub and "Failing check blocks" was not exercised. Recommendation: after the PR is opened, confirm the first run is green; optionally push a deliberately failing commit to a throwaway branch.
2. Evidence Methods do not each state the pi version (spec: "pi version, executor or package versions, steps"). Recommendation: add `pi 1.5.2` to the first line of every Method in `docs/evidence/host-seams.md`, and extend `tests/evidence.test.ts` to check it.
3. `readVersion` signature differs from the plan Contract and the deviation is not recorded. Recommendation: record it in `apply.md` under Contract deviations or update `plan.md`.
4. The real `~/.pi/agent/auth.json` was read and a copy printed once during probes, against the spirit of the "do not alter the user's pi configuration" requirement; the file itself was unchanged. See `apply.md` incident; the Command Code key still needs rotating by the person.
5. `docker volume prune -f` was run outside the plan (see `apply.md`).

SUGGESTION:
1. Evidence line 7 links "security.md" to the generic `https://github.com/earendil-works/pi`, which may not resolve to that document. Recommendation: cite the local pi docs path (`docs/security.md`, "Project trust without an interactive prompt") instead.
2. The "Command has no side effects" test only checks messages. Recommendation: also assert no `exec`/file calls on the fake API.
3. The "Unverified probe" test rule is vacuous while no probe is unverified. Recommendation: add a unit test of the rule with a synthetic document.

**Next step**:

Run `/opsx-continue` with the worktree as working directory to create the finalize artifact, then `/opsx-archive`. Warnings 2 and 3 are cheap to fix first; the PASS_WITH_WARNINGS outcome does not require it.
