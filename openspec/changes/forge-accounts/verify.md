# Verification Report

**Change**: `forge-accounts`
**Verified at**: `2026-11-15 15:47`
**Iteration**: `1`
**Verifier**: parent session (pi, `claude-opus-5-5`). It ran every check inline in the worktree `/Users/naicoi/Projects/oss/pi-livespec.forge-accounts`.

---

## 1. Structural Validation (`openspec validate <change>`)

- [x] The command passes for this change

```text
$ openspec validate forge-accounts
Change 'forge-accounts' is valid        (exit 0)
$ openspec validate forge-accounts --strict
Change 'forge-accounts' is valid        (exit 0)
```

---

## 2. Task Completion (`tasks.md`)

- [x] Every box is ticked, or each open box has a recorded reason

Evidence:
- `grep -c "^- \[ \]"` returns `0` and `grep -c "^- \[x\]"` returns `19`.
- `openspec instructions apply` reports progress `{"total":19,"complete":19,"remaining":0}`.

| Open task | Reason | Blocks archive? |
|---|---|---|
| — | — | — |

---

## 3. Requirement Evidence

- [ ] ADDED / MODIFIED: implementation evidence (file / line). One requirement fails, see the table.
- [x] REMOVED: not applicable (none)
- [x] RENAMED: not applicable (none)

| Requirement | Operation | Status | Evidence (file:line) or reason |
|---|---|---|---|
| forge-accounts / Per-clone account storage | ADDED | Pass | src/accounts/store.ts:45 (readStored, `--local`), :54 (writeStored) |
| forge-accounts / No machine-wide preference | ADDED | Pass | src/accounts/select.ts:56 (no active/default inputs in SelectionFacts) |
| forge-accounts / Candidate discovery | ADDED | Pass | src/accounts/candidates.ts:20 |
| forge-accounts / Write access check | ADDED | Pass | src/accounts/access.ts:33, :48 |
| forge-accounts / Account selection | ADDED | Pass | src/accounts/select.ts:56 |
| forge-accounts / Environment token override | ADDED | Pass | src/accounts/select.ts:56; src/hooks/session.ts:311–313 |
| forge-accounts / Selection rules | ADDED | Pass | src/accounts/select.ts:56 |
| forge-accounts / Selection at session start | ADDED | Pass | src/hooks/session.ts (startSession → reconnect), src/accounts/resolve.ts:74 |
| forge-accounts / Ask once | ADDED | Pass | src/hooks/session.ts:426 (ui.select); src/accounts/resolve.ts:74 |
| forge-accounts / Identity confirmation | ADDED | Pass | src/hooks/session.ts:346 (confirmIdentity) |
| forge-accounts / Writes blocked without a confirmed identity | ADDED | Pass | src/tools/guard.ts:51; src/hooks/session.ts:192 (applyAdvance) |
| forge-accounts / Account command | ADDED | Pass | src/commands/account.ts:15; src/accounts/resolve.ts:212 |
| forge-accounts / Account switch refusals | ADDED | Pass | src/accounts/resolve.ts:212 |
| forge-accounts / Doctor and card report | ADDED | Pass | src/accounts/doctor.ts:9; src/accounts/card.ts:6 |
| forge-accounts / Secret handling | ADDED | **Fail** | src/hooks/session.ts:329 — `tokens` is built only from `resolved.token`; on a refused Gitea selection the adapter reads with `readOnlyLogin` (session.ts:311) whose token is never added, so `RedactingForge` cannot redact it |
| github-adapter / GitHub transport and auth | MODIFIED | Pass | src/forge/github.ts:61 (tokenEnvVar), per-call env in `run` |
| gitea-adapter / Gitea transport and auth | MODIFIED | Pass | src/forge/tea-config.ts:43 (findGiteaToken), :52 (teaLogins) |
| forge-interface / Forge detection | MODIFIED | Pass | src/forge/detect.ts:98 (detectForge), :108 (resolveForgeTarget) |

---

## 4. Scenario Coverage

- [x] Every scenario maps to a test
- [x] The project test command was run fresh in this step

**Test command**: `bun run test` (vitest run), in the worktree.

**Result**: green on the final runs, with one isolated flake.

| Run | Result | Exit |
|---|---|---|
| 1 (first fresh run) | `1 failed \| 1151 passed (1152)` | 1 |
| 2–23 (22 runs, 6 of them with a concurrent typecheck for load) | `1152 passed (1152)` each | 0 |

The failing test of run 1 was not captured, because output was filtered to the summary line, and 22 reruns did not reproduce it. This is recorded as a WARNING below.

`bun run typecheck` (`tsc --noEmit`): exit 0.

**How the table was built:** the 73 `#### Scenario:` titles of the four delta specs were matched against `it`/`test` calls and `it.each` table rows with the same name.
- 64 match directly.
- The 9 baseline scenarios from LS-03 map to the existing tests named in `plan.md`. Each of those titles was found with `grep -F`.

| Scenario | Test |
|---|---|
| forge-accounts / Stored locally | `tests/accounts/store.test.ts:42` |
| forge-accounts / Global value ignored | `tests/accounts/store.test.ts:55` |
| forge-accounts / Shared by worktrees | `tests/hooks/session-account.test.ts:130` |
| forge-accounts / Unsafe value refused | `tests/accounts/store.test.ts:72` |
| forge-accounts / Tea default ignored | `tests/accounts/select.test.ts:26` |
| forge-accounts / GitHub candidates | `tests/accounts/candidates.test.ts:25` |
| forge-accounts / Gitea candidates | `tests/accounts/candidates.test.ts:45` |
| forge-accounts / Gitea candidates behind an SSH host | `tests/accounts/candidates.test.ts:58` |
| forge-accounts / Push permission | `tests/accounts/access.test.ts:24` |
| forge-accounts / Missing field | `tests/accounts/access.test.ts:38` |
| forge-accounts / Unreachable | `tests/accounts/access.test.ts:44` |
| forge-accounts / Active account ignored | `tests/accounts/select.test.ts:22` |
| forge-accounts / Environment token wins | `tests/accounts/select.test.ts:35` |
| forge-accounts / Other forge's token ignored | `tests/accounts/select.test.ts:39` |
| forge-accounts / Environment identity outside the registry | `tests/hooks/session-account.test.ts:220` |
| forge-accounts / Invalid environment token | `tests/hooks/session-account.test.ts:230` |
| forge-accounts / Stored account reused | `tests/accounts/select.test.ts:48` |
| forge-accounts / Single writer chosen automatically | `tests/accounts/select.test.ts:57` |
| forge-accounts / Several writers with UI | `tests/accounts/select.test.ts:61` |
| forge-accounts / Several writers without UI | `tests/accounts/select.test.ts:65` |
| forge-accounts / No writer | `tests/accounts/select.test.ts:74` |
| forge-accounts / Stale stored account | `tests/accounts/select.test.ts:81` |
| forge-accounts / Stored account disappeared | `tests/accounts/select.test.ts:85` |
| forge-accounts / Remote changed | `tests/accounts/select.test.ts:89` |
| forge-accounts / Offline with stored account | `tests/accounts/select.test.ts:99` |
| forge-accounts / Unknown stored account loses to a writer | `tests/accounts/select.test.ts:108` |
| forge-accounts / Denied stored account not revived | `tests/accounts/select.test.ts:112` |
| forge-accounts / First session | `tests/hooks/session-account.test.ts:86` |
| forge-accounts / Later session | `tests/hooks/session-account.test.ts:105` |
| forge-accounts / Uninitialized project | `tests/content/expose.test.ts:39` |
| forge-accounts / Answer stored | `tests/accounts/resolve.test.ts:62` |
| forge-accounts / Cancelled | `tests/accounts/resolve.test.ts:81` |
| forge-accounts / Confirmed candidate | `tests/hooks/session-account.test.ts:152` |
| forge-accounts / Mismatch blocks writes | `tests/hooks/session-account.test.ts:162` |
| forge-accounts / Refusal blocks writes | `tests/hooks/session-account-gitea.test.ts:51` |
| forge-accounts / Automatic advance blocked | `tests/hooks/session-account.test.ts:193` |
| forge-accounts / Identity unconfirmed | `tests/hooks/session-account.test.ts:204` |
| forge-accounts / Show | `tests/commands/account.test.ts:78` |
| forge-accounts / Switch | `tests/commands/account.test.ts:95` |
| forge-accounts / Switch refused without access | `tests/commands/account.test.ts:111` |
| forge-accounts / Unknown name | `tests/commands/account.test.ts:123` |
| forge-accounts / Environment override | `tests/commands/account.test.ts:134` |
| forge-accounts / Doctor ok | `tests/accounts/doctor.test.ts:85` |
| forge-accounts / Doctor unverified | `tests/accounts/doctor.test.ts:99` |
| forge-accounts / Doctor blocked | `tests/accounts/doctor.test.ts:112` |
| forge-accounts / Card quiet in steady state | `tests/accounts/card.test.ts:61` |
| forge-accounts / Card after automatic choice | `tests/accounts/card.test.ts:77` |
| forge-accounts / Card after asked choice | `tests/accounts/card.test.ts:86` |
| forge-accounts / Card when blocked | `tests/accounts/card.test.ts:100` |
| forge-accounts / No token in arguments | `tests/accounts/secrets.test.ts:113` |
| forge-accounts / No token in output on failure | `tests/accounts/secrets.test.ts:134` |
| forge-accounts / Untrusted forge text | `tests/accounts/card.test.ts:111` |
| forge-interface / GitHub remote | `tests/forge/detect.test.ts:81 ("selects GitHub for a github.com remote without probing") (baseline test)` |
| forge-interface / Gitea by config | `tests/forge/detect.test.ts:158 ("selects Gitea by config without probing") (baseline test)` |
| forge-interface / Gitea by configured URL | `tests/forge/detect.test.ts:353` |
| forge-interface / Gitea by tea SSH host | `tests/forge/detect.test.ts:366` |
| forge-interface / Gitea by probe | `tests/forge/detect.test.ts:169 (baseline test)` |
| forge-interface / Unknown host | `tests/forge/detect.test.ts:177 (baseline test)` |
| forge-interface / Account passed to GitHub | `tests/forge/detect.test.ts:268` |
| forge-interface / Account passed to Gitea | `tests/forge/detect.test.ts:290` |
| gitea-adapter / Token from environment | `tests/forge/gitea.test.ts:48 (baseline test)` |
| gitea-adapter / Token from tea config | `tests/forge/gitea.test.ts:55 (baseline test)` |
| gitea-adapter / Named login | `tests/forge/gitea.test.ts:109` |
| gitea-adapter / Ambiguous logins | `tests/forge/gitea.test.ts:120` |
| gitea-adapter / Named login missing | `tests/forge/gitea.test.ts:137` |
| gitea-adapter / Named login for another host | `tests/forge/gitea.test.ts:150` |
| gitea-adapter / No token | `tests/forge/gitea.test.ts:71 (baseline test)` |
| github-adapter / Not logged in | `tests/forge/github.test.ts:26 (baseline test)` |
| github-adapter / Identity | `tests/forge/github.test.ts:67 (baseline test)` |
| github-adapter / Account token used | `tests/forge/github.test.ts:394` |
| github-adapter / Enterprise host token | `tests/forge/github.test.ts:405` |
| github-adapter / Token not in arguments | `tests/forge/github.test.ts:415` |
| github-adapter / No token given | `tests/forge/github.test.ts:425` |

---

## 5. Design and Contract Coherence (warning only)

- [x] Decisions in design.md match the code, except the token-redaction gap listed under issues
- [x] Contracts in plan.md, with the Contract deviations recorded in apply.md, match the code

### Contracts compared, read-only

**Adapters and detection**

| Contract | Result | Compared with |
|---|---|---|
| `ExecFn` (+`env`, +`signal` deviation), `tokenEnvVar` | matched | `src/forge/github.ts:61`, `createExec` |
| `GitHubForgeOptions.token`, `GiteaOptions/TeaLookup.login`, `findGiteaToken`, `teaLogins` (+`sshHost`) | matched | `src/forge/github.ts`; `src/forge/tea-config.ts:43,52` |
| `DetectDeps.account` (+`teaLookup` deviation), `ForgeTarget`/`resolveForgeTarget` | matched | `src/forge/detect.ts:98,108` |
| `RedactingForge` | matched in shape | `src/forge/redact.ts:9`. The token list it gets is incomplete; see the issues |

**Account types and logic**

| Contract | Result | Compared with |
|---|---|---|
| `AccountCandidate`, `Access`, `StoredAccount`, `AccountSource`/`SOURCE_LABEL`, `SelectionFacts`, `SelectionResult`, `AccountEnv` | matched | `src/accounts/types.ts` |
| Git config keys, `readStored`/`writeStored` (+`forge` deviation) | matched | `src/accounts/store.ts:8–9,45,54` |
| `listCandidates`, `candidateToken`, `checkAccess`/`checkAll` (`ForgeTarget` deviation), `redactTokens` | matched | `src/accounts/candidates.ts:20`; `token.ts`; `access.ts:33,48`; `redact.ts` |
| `selectAccount` | matched | `src/accounts/select.ts:56` |
| `ResolvedAccount` (`source?`, `readOnlyLogin?` deviations), `resolveAccount`, `chooseAccount` | matched | `src/accounts/resolve.ts:31,74,212` |

**Session, command, doctor and card**

| Contract | Result | Compared with |
|---|---|---|
| `SessionDeps.accounts`, `Session.account`/`accountBlock`/`target`/`accountNotice`/`reconnect`/`switchAccount` (+`bind`) | matched | `src/hooks/session.ts` |
| `/livespec account [name]` and `USAGE` | matched | `src/extension.ts`; `src/commands/account.ts:15` |
| `DoctorDeps.account`/`accountBlock`, doctor check `forge-account` | matched | `src/commands/doctor.ts`; `src/accounts/doctor.ts:9` |
| `CardInput.account`, card section `forge-account` | matched | `src/hooks/phase-card.ts`; `src/accounts/card.ts:6` |

**Dependencies:** matched. `package.json` `dependencies` is exactly `{ "yaml": "^2.9.1" }`.

**Internal deviations listed in apply.md:** present as recorded.

### Drift warnings (non-blocking)

- design.md "Tokens" says every token the adapter uses is known to the redaction. That is not true for the Gitea read-only fallback login. The functional gap is listed under issues as CRITICAL.

### Not verified

- **Real Gitea behaviour** (named login, ambiguity, `ssh_host` mapping, read-only fallback): covered only by the loopback fake; no real server was available.
- **Real `gh` output formats:** covered by the fake `gh` plus the GitHub smoke (`smoke.md`, PASS).

---

## 6. Clean Tree and Commit Range

- [x] Working tree is clean. `git status --porcelain` shows only `?? .codegraph/`, the local CodeGraph index. It is not part of the change and is not committed.

**Commit range**: `c4e2cc9..5a8535f`. `c4e2cc9` is the scaffold commit on feature branch `spec/forge-accounts`; `5a8535f` holds the apply receipt.

---

## Issues

### CRITICAL

**Gitea read-only fallback token is not redacted** (`src/hooks/session.ts:311,329`; spec `forge-accounts` / Requirement: Secret handling).

- **What happens:**
  - On a refused Gitea selection, `detectAccount` hands the adapter `{ name: resolved.readOnlyLogin }`.
  - `connectWithAccount` builds the redaction list from `resolved.token`, which is undefined for a refusal.
  - A Gitea HTTP error that echoes the credential then reaches `session.errors`, the card, doctor or tool output unredacted. The requirement says tokens "MUST NOT appear in any notice, error, … card, …, including on failure".
- **Recommendation (`/opsx-apply` iteration 2):**
  1. When `readOnlyLogin` is set, fetch that login's token through `d.accounts` with `candidateToken(d.accounts, target, readOnlyLogin)`.
  2. Add it to the `tokens` list given to `RedactingForge`, and to the `redactTokens` call in the `catch` at `session.ts:336`.
  3. Do not store the login, do not set `resolved.account`, and keep `accountBlock` set.
- **Regression test** in `tests/hooks/session-account-gitea.test.ts`: two `tea` logins and a refused selection. The fake Gitea answers a read with an error body containing the read-only login's token. The token must be absent from `session.errors`, `session.forgeError`, the card text and the `spec_status` result, and writes must stay refused.

### WARNING

**One flaky test in the first fresh run.**
- **What happened:** `bun run test` failed 1 of 1152 once. It was not reproduced in 22 reruns, including 6 under load, and the test name was not captured.
- **Likely candidates:** the wall-clock assertions `tests/hooks/harness.test.ts:17` (`< 5_000` ms), `tests/forge/github.test.ts:337` (`< 5_000` ms), `tests/content/manager.test.ts:423` and `tests/content/root-lock.test.ts:52` (`< 1000` ms).
- **Recommendation:** in iteration 2, run the suite with `--reporter=verbose` and keep the failure output when it recurs. Relax or remove the wall-clock bounds where a stderr or behaviour assertion already proves the point. Earlier review ledgers flagged `harness.test.ts` as a candidate.

### SUGGESTION

- **Misleading card hint under an environment token** (`src/accounts/card.ts`): the card suggests `/livespec account <name>` while an environment token decides and switching is refused. Name the environment variable instead.
- **Layering of `untrusted()`** (`src/hooks/phase-card.ts`): move it to a neutral module, for example `src/core/untrusted.ts`, so `src/accounts/*` does not import from hooks.
- **Pending-`whoami` regression:** also assert that the read surfaces (the card, `spec_status`) answer without throwing while `whoami` is pending.

---

## Overall Decision

- [ ] PASS: proceed with `/opsx-continue` to finalize
- [ ] PASS_WITH_WARNINGS: proceed, noting the warnings
- [x] FAIL: fix the cause, then re-apply (iteration 2)

**Next step**:

This is iteration 1 of 5.
1. Run `/opsx-apply` in `/Users/naicoi/Projects/oss/pi-livespec.forge-accounts`. It detects the `FAIL`, runs a fix iteration (reading `systematic-debugging`) for the CRITICAL item, and records iteration 2 in `apply.md`.
2. Then run `/opsx-verify` again.

> **Convergence loop reminder**:
> - PASS / PASS_WITH_WARNINGS: `/opsx-continue` advances to the finalize artifact.
> - FAIL, code-fixable: load `systematic-debugging`, re-run `/opsx-apply`, then verify again.
> - FAIL, artifact-level: fix the artifact, then re-run `/opsx-apply`.
> - Stop after 5 iterations and report to the user.
