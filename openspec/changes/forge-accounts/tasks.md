## 1. Adapters accept an account

Blocked by: none

- [x] 1.1 Add the optional `env` argument to `ExecFn` and `createExec` in `src/forge/github.ts`, plus `tokenEnvVar(hostname)` (`GH_TOKEN` for `github.com` and `*.ghe.com`, else `GH_ENTERPRISE_TOKEN`)
- [x] 1.2 Add `GitHubForgeOptions.token`: every `gh` call (`api`, `auth status`) passes it in `tokenEnvVar(host)`, never in argv. Extend the fake `gh`: record the env, keep an accounts registry (`auth status --json`, `auth token`), and answer identity, authorship and `repos/{o}/{r}` push permission per token
- [x] 1.3 Add `login` to `GiteaOptions` and `TeaLookup` in `src/forge/tea-config.ts`, `gitea.ts` and `gitea-transport.ts`: a named login must match the host; several matching logins with no name throw `auth` naming them
- [x] 1.4 Add `account?: { name; token? }` to the `detectForge` deps in `src/forge/detect.ts`, passing it to the chosen adapter. Factor out `resolveForgeTarget` so account resolution uses the same endpoint. Gitea detection also maps an `origin` host equal to a `tea` login's `ssh_host` to that login's URL; `giteaUrl` and `host` config keep working for any domain

## 2. Account discovery, access and storage

Blocked by: 1

- [x] 2.1 Add `src/accounts/types.ts` (candidate, access, stored value, selection facts and result, source labels, `AccountEnv`) and `src/accounts/env.ts` (`defaultAccountEnv`)
- [x] 2.2 Add `src/accounts/candidates.ts`: GitHub candidates from `gh auth status --json hosts`, Gitea candidates from the `tea` config logins for the host
- [x] 2.3 Add `src/accounts/token.ts` (GitHub `gh auth token --hostname --user`; Gitea login token) and `src/accounts/redact.ts` (`redactTokens`)
- [x] 2.4 Add `src/accounts/access.ts`: per-candidate push check with that candidate's token, `true` / `false` / `unknown`, 5 s timeout, at most 4 in parallel
- [x] 2.5 Add `src/accounts/store.ts`: `git config --local` read and write of `livespec.account` and `livespec.accountRemote`, with value validation and `--end-of-options`

## 3. Pure selection

Blocked by: 2

- [x] 3.1 Add `src/accounts/select.ts`: `selectAccount(facts)` implementing the environment override and the selection rules, with table tests for every selection scenario

## 4. Session integration and write block

Blocked by: 3

- [x] 4.1 Add `src/accounts/resolve.ts` (`resolveAccount`, `chooseAccount`): gather facts, call `selectAccount`, ask through `ctx.ui.select` when the result is "ask", store, and notify once. Add `src/forge/redact.ts` (`RedactingForge`)
- [x] 4.2 Wire resolution into `connectForge` in `src/hooks/session.ts`, for initialized projects only: target, resolve, build the adapter with the account, wrap it in redaction and cache, then confirm `whoami`. Add `SessionDeps.accounts`, `session.accountBlock`, `accountNotice`, `reconnect()`, `switchAccount()` and `CardInput.account`
- [x] 4.3 Block every forge mutation on `accountBlock`: `requireWritable` in `src/tools/guard.ts` and `applyAdvance` in `src/hooks/session.ts`; the block is independent of read-only mode

## 5. Command, doctor and card

Blocked by: 4

- [x] 5.1 Add `/livespec account [name]` in `src/commands/account.ts` and route it in `src/extension.ts` (usage text updated)
- [x] 5.2 Add the `forge-account` doctor check in `src/accounts/doctor.ts` (report only) and the `forge-account` card section in `src/accounts/card.ts` (untrusted wrapping, quiet in steady state)
- [x] 5.3 Secret-handling tests across the flow: no token in argv, errors, doctor, card or tool details

## 6. Docs, manual check and suite

Blocked by: 5

- [ ] 6.1 Update `docs/architecture.md` (forge accounts per clone) and the forge-related lines of the README if any
- [ ] 6.2 Manual check on this machine: a real session in a clone of `ttdua/pi-livespec` selects `ttdua` automatically while `naicoi92` is the active `gh` account; record it in `openspec/changes/forge-accounts/smoke.md`
- [ ] 6.3 Run `bun run typecheck` and `bun run test`
