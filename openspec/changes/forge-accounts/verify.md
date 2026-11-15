# Verification Report

**Change**: `forge-accounts`
**Verified at**: `2026-11-15 16:07`
**Iteration**: `2`
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

- [x] ADDED / MODIFIED: implementation evidence (file / line)
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
| forge-accounts / Secret handling | ADDED | Pass | src/hooks/session.ts:329 (list built before the lookup), :347 `knownTokens` (the chosen token plus the forge's environment token), :357 `redactionTokens` (adds the read-only login's token); src/forge/redact.ts:9 |
| github-adapter / GitHub transport and auth | MODIFIED | Pass | src/forge/github.ts:61 (tokenEnvVar), per-call env in `run` |
| gitea-adapter / Gitea transport and auth | MODIFIED | Pass | src/forge/tea-config.ts:43 (findGiteaToken), :52 (teaLogins) |
| forge-interface / Forge detection | MODIFIED | Pass | src/forge/detect.ts:98 (detectForge), :108 (resolveForgeTarget) |

---

## 4. Scenario Coverage

- [x] Every scenario maps to a test
- [x] The project test command was run fresh in this step

**Test command**: `bunx vitest run --reporter=verbose`, the project test runner (`bun run test` runs `vitest run`) with verbose output so any failure is named. Run in the worktree at HEAD `b05724f`.

**Result**: exit 0. `Test Files 84 passed (84)`, `Tests 1154 passed (1154)`: 1154 `✓` lines and no `×`.

`bun run typecheck` (`tsc --noEmit`): exit 0.

The iteration 1 regressions for Secret handling are in the suite and pass:
- `tests/hooks/session-account-gitea.test.ts:89`, "a forge error echoing the read-only login's token is redacted";
- `tests/hooks/session-account-gitea.test.ts:109`, "a forge error echoing GITEA_TOKEN is redacted when the selection fails".

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

- [x] Decisions in design.md match the code
- [x] Contracts in plan.md, with the Contract deviations recorded in apply.md, match the code

### Contracts compared, read-only

**Adapters and detection**

| Contract | Result | Compared with |
|---|---|---|
| `ExecFn` (+`env`, +`signal` deviation), `tokenEnvVar` | matched | `src/forge/github.ts:61`, `createExec` |
| `GitHubForgeOptions.token`, `GiteaOptions/TeaLookup.login`, `findGiteaToken`, `teaLogins` (+`sshHost`) | matched | `src/forge/github.ts`; `src/forge/tea-config.ts:43,52` |
| `DetectDeps.account` (+`teaLookup` deviation), `ForgeTarget`/`resolveForgeTarget` | matched | `src/forge/detect.ts:98,108` |
| `RedactingForge` | matched | `src/forge/redact.ts:9`, fed by `redactionTokens` (`src/hooks/session.ts:357`) |

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

**Internal deviations listed in apply.md**, including iteration 2's private `knownTokens` and `redactionTokens` and the test seams `FakeGitea.echoTokenOnRead` and `HarnessOptions.accountGit`: present as recorded.

### Drift warnings (non-blocking)

None.

### Not verified

- **Real Gitea behaviour** (named login, ambiguity, `ssh_host` mapping, read-only fallback): covered only by the loopback fake; no real server was available.
- **Real `gh` output formats:** covered by the fake `gh` plus the GitHub smoke (`smoke.md`, PASS).

---

## 6. Clean Tree and Commit Range

- [x] Working tree is clean. `git status --porcelain` shows only `?? .codegraph/`, the local CodeGraph index. It is not part of the change and is not committed.

**Commit range**: `c4e2cc9..b05724f`, with HEAD `b05724f` holding the iteration 2 apply receipt. Iteration 2 fix commits: `7b71430`, `4f40865`.

---

## Issues

### CRITICAL

None. The iteration 1 CRITICAL item, the Gitea read-only fallback token not being redacted, is fixed at `src/hooks/session.ts:329,347,357` and covered by `tests/hooks/session-account-gitea.test.ts:89`. The related environment-token path is covered by `:109`.

### WARNING

1. **Intermittent test timeouts.** Not reproduced in this run, which was green.
   - **History:** iteration 1 verify had one unnamed failure in 1152 tests. In iteration 2, `tests/accounts/secrets.test.ts` › "No token in arguments" once hit its 5 s timeout. That test takes about 2.5 s on its own.
   - **Recommendation:** give that test an explicit longer timeout, for example `test(name, fn, 15_000)`, or cut its subprocess count. Replace the wall-clock bounds with behaviour assertions: `tests/hooks/harness.test.ts:17`, `tests/forge/github.test.ts:337`, `tests/content/manager.test.ts:423`, `tests/content/root-lock.test.ts:52`.
2. **Not verified: real Gitea.** Gitea behaviour is covered only by the loopback fake: named login, ambiguity, `ssh_host` mapping, the read-only fallback and its redaction.
   - **Recommendation:** before release, run one manual session against a self-hosted Gitea with two `tea` logins for the host and no UI. Expect writes refused, reads working, and no token in the card or doctor output. Record it in `smoke.md`.
3. **GitHub environment-token redaction on a failed selection has no test of its own.** It shares the code path with the Gitea test (`envTokenVar(target)`, `src/hooks/session.ts:347`).
   - **Recommendation:** add a hook test with `GH_TOKEN` set and the stored-account read failing, where the fake `gh` echoes the token in stderr. Assert the token is absent from `session.errors` and the card.

### SUGGESTION

- **Misleading card hint under an environment token** (`src/accounts/card.ts`): the card suggests `/livespec account <name>` while an environment token decides and switching is refused. Name the environment variable instead.
- **Layering of `untrusted()`** (`src/hooks/phase-card.ts`): move it to a neutral module, for example `src/core/untrusted.ts`, so `src/accounts/*` does not import from hooks.
- **Pending-`whoami` regression:** also assert that the read surfaces (the card, `spec_status`) answer without throwing while `whoami` is pending.

---

## Overall Decision

- [ ] PASS: proceed with `/opsx-continue` to finalize
- [x] PASS_WITH_WARNINGS: proceed, noting the warnings
- [ ] FAIL: fix the cause, then re-apply

**Next step**:

From the worktree `/Users/naicoi/Projects/oss/pi-livespec.forge-accounts`:
1. Run `/opsx-continue` to create `finalize.md`.
2. Then run `/opsx-archive`.

This change is cut from `ls-04`, so its PR merges after PR #15.
