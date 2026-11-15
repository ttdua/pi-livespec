# Forge Accounts Implementation Plan

> Executed via `/opsx-apply`, which chooses the executor.
> Spec reference: this change's `specs/` and `design.md`.

**Goal:** Each clone uses one known forge account. livespec finds it from the `gh` accounts and `tea` logins by write access, stores it in the clone's local git config, asks once only when several can write, and never writes as an unconfirmed identity.

**Architecture:**
- The adapters gain an account input: a GitHub token passed through the per-call env, and a Gitea login name.
- A new `src/accounts/` module gathers the facts (candidates, access, stored value) and decides with a pure `selectAccount`. Side effects happen only in `resolve.ts`.
- Session start resolves the account before connecting.
- The block on an unconfirmed identity covers the write tools and the automatic phase advance.
- The command, doctor check and card section plug into the existing LS-04 seams.

**Tech Stack:** TypeScript (ESM, `.ts` imports, `strict`), vitest, bun, the `gh` and `git` executables, Node `fetch`, `yaml` (already a dependency).

**Spec:** `openspec/changes/forge-accounts/specs/` (forge-accounts, github-adapter, gitea-adapter, forge-interface) and `openspec/changes/forge-accounts/design.md`.

## Global Constraints

- `dependencies` stays exactly `{ "yaml": ... }`; add no dependency.
- Use `bun`/`bunx` only: `bun run test` and `bun run typecheck`.
- All code, comments, docs and commit messages are in English.
- **No network in tests:** no call beyond loopback. GitHub is the fake `gh` (`tests/forge/fake-gh/`) and Gitea is the loopback fake (`tests/forge/fake-gitea.ts`).
- **Temp state only:** git repos are temp repos, and `$HOME` and the `tea` config path are injected. Tests never read the real `gh` or `tea` credentials.
- **Tokens:** they appear only in a subprocess env or an HTTP header. They never appear in argv, notices, errors, doctor, card, cache, logs or tool details.
- **Git config:** only `git config --local`; every git operand goes after `--end-of-options`.
- **Machine-wide preferences:** the active `gh` account and the `tea` default flag never decide a selection.
- **Hooks:** a livespec hook never throws into pi.
- **Untrusted text:** forge text shown to the model is wrapped in `<untrusted>…</untrusted>`.
- **Test names:** each new scenario test is named exactly after its `#### Scenario:` title.
- **Coding standards:** `~/.agents/skills/coding-standards/SKILL.md` — one responsibility per module, no god function, no swallowed errors.

## Review Focus

1. **Slow or hanging `gh`:** a candidate check that never returns must time out as `unknown` and must not block session start beyond its cap. Task 2 test: `access check times out as unknown`.
2. **`gh` without `--json` support (older `gh`):** `gh auth status --json` failing must give zero candidates with a readable reason, not a crash. Task 2 test: `gh without json status gives no candidates and a reason`.
3. **Malformed `tea` config:** invalid YAML, `logins` that is not a list, or entries without `url` must give no Gitea candidates and no crash. Task 2 test: `malformed tea config gives no candidates`.
4. **Token that looks like an option or contains a newline:** it must never be stored or put on argv. It goes only to env or a header, so a strange value is harmless. Task 1 test: `token with leading dash never reaches argv`.
5. **The UI disappearing mid-question:** `ctx.ui.select` throwing must behave like a cancel (refuse writes, explain), never reject the session hook. Task 4 test: `ui select throwing is treated as cancelled`.

---

## Contracts

**Adapters and detection**

| Name | new / modified | Shape | public |
|---|---|---|---|
| `ExecFn` | modified | `(file: string, args: string[], input?: string, env?: Record<string, string>) => Promise<ExecResult>`; `env` is merged over `process.env` for that run only | yes |
| `tokenEnvVar` | new | `tokenEnvVar(hostname: string \| undefined): "GH_TOKEN" \| "GH_ENTERPRISE_TOKEN"` in `src/forge/github.ts`. `undefined`, `github.com` and `*.ghe.com` give `GH_TOKEN`; anything else gives `GH_ENTERPRISE_TOKEN` | yes |
| `GitHubForgeOptions` | modified | adds `token?: string` | yes |
| `GiteaOptions` / `TeaLookup` | modified | add `login?: string` | yes |
| `findGiteaToken` | modified | `GITEA_TOKEN`, else the named login (its URL host must equal the server's), else the single login whose URL host matches. Several matches and no name → `ForgeError("auth")` naming them | yes |
| `teaLogins` | new | `teaLogins(lookup: TeaLookup): Promise<{ name: string; url: string; user: string; token: string; sshHost?: string }[]>`; reads the config, never spawns `tea`. Exported for discovery | yes |
| `DetectDeps.account` | new | `account?: { name: string; token?: string }`. `token` goes to `GitHubForge`, `name` goes to `GiteaForge` as `login` | yes |
| `ForgeTarget` / `resolveForgeTarget` | new | `ForgeTarget = { kind: "github" \| "gitea"; host: string; authority: string; baseUrl: string; owner: string; repo: string }`. `resolveForgeTarget(repoRoot, deps?): Promise<ForgeTarget>` in `src/forge/detect.ts`. It is the same remote, config and probe logic `detectForge` uses, factored out, and `detectForge` builds its adapter from it. Account resolution and adapters therefore use the same endpoint, including a `giteaUrl` override and a loopback port.

Gitea order: config (`giteaUrl` or `host`), then the `tea` login whose `ssh_host` equals `origin`'s host (exact, case-insensitive, port ignored; several different URLs means no match), then the probe. `teaLogins` entries carry `sshHost?: string` | yes |
| `RedactingForge` | new | `new RedactingForge(inner: Forge, tokens: () => string[])` in `src/forge/redact.ts`: a `Forge` decorator. Every thrown `ForgeError` gets its `message` passed through `redactTokens`. The session wraps the account adapter in it, below `CachedForge` | no |

**Account types and storage**

| Name | new / modified | Shape | public |
|---|---|---|---|
| `AccountCandidate` | new | `{ name: string; user: string }` in `src/accounts/types.ts` | yes |
| `Access` | new | `"true" \| "false" \| "unknown"`, a string union for clarity | yes |
| `StoredAccount` | new | `{ account: string; remote: string }`; `remote` is `<host>/<owner>/<repo>` | yes |
| `AccountSource` | new | `"env" \| "stored" \| "auto" \| "asked"`; `SOURCE_LABEL = { env: "environment", stored: "stored", auto: "automatic", asked: "asked" }` | yes |
| `SelectionFacts` (in `types.ts`, Task 2) | new | `{ forge: "github" \| "gitea"; envToken: boolean; stored?: StoredAccount; remote: string; candidates: { candidate: AccountCandidate; access: Access }[]; hasUI: boolean }` | yes |
| `SelectionResult` | new | `{ kind: "env" } \| { kind: "use"; account: string; source: "stored"; unverified: boolean } \| { kind: "store"; account: string; source: "auto" } \| { kind: "ask"; options: string[] } \| { kind: "refuse"; reason: "ambiguous" \| "no-access" \| "no-candidates" \| "invalid"; options: string[] }` | yes |
| Git config keys | new | `livespec.account = <name>`, `livespec.accountRemote = <host>/<owner>/<repo>`; local scope only | yes |
| `readStored` / `writeStored` | new | `readStored(git: GitExec, root: string): Promise<StoredAccount \| undefined>`; `writeStored(git: GitExec, root: string, s: StoredAccount): Promise<void>` in `src/accounts/store.ts`. A name is valid when it has no control characters, does not start with `-`, and is at most 100 characters | no |

**Account functions**

| Name | new / modified | Shape | public |
|---|---|---|---|
| `listCandidates` | new | `listCandidates(d: CandidateDeps, forge: "github" \| "gitea", host: string, baseUrl?: string): Promise<{ candidates: AccountCandidate[]; reason?: string }>` in `src/accounts/candidates.ts` | no |
| `candidateToken` | new | `candidateToken(d: TokenDeps, forge, host, name): Promise<string \| undefined>` in `src/accounts/token.ts` | no |
| `checkAccess` | new | `checkAccess(d: AccessDeps, forge, host, repo: { owner: string; repo: string }, candidate: AccountCandidate): Promise<Access>`; 5 s timeout (`ACCESS_TIMEOUT_MS = 5_000`); `checkAll(…)` with concurrency `ACCESS_CONCURRENCY = 4` | no |
| `redactTokens` | new | `redactTokens(text: string, tokens: string[]): string`, replacing each non-empty token with `***`, in `src/accounts/redact.ts` | no |
| `selectAccount` | new | `selectAccount(f: SelectionFacts): SelectionResult` (pure) in `src/accounts/select.ts` | yes |
| `ResolvedAccount` | new | `{ source: AccountSource; account?: string; user?: string; token?: string; unverified: boolean; block?: string; notice?: string; facts: SelectionFacts }` | no |
| `AccountEnv` | new | `{ exec: ExecFn; git: GitExec; env: Record<string, string \| undefined>; fetch: typeof fetch; teaLookup: Omit<TeaLookup, "baseUrl" \| "login">; now: () => number }` in `src/accounts/types.ts`. It is the single injection seam for every account I/O: `gh`, `git`, the HTTP access check and the tea config path. The default is `defaultAccountEnv()` over the real process | no |
| `resolveAccount` | new | `resolveAccount(target: ForgeTarget, root: string, ui: { hasUI: boolean; select?(title: string, options: string[]): Promise<string \| undefined> }, env: AccountEnv): Promise<ResolvedAccount>` in `src/accounts/resolve.ts`. It does not call `whoami`; identity is confirmed in the session (Task 4). The 5 s per-candidate cap covers both the token lookup and the access call | no |
| `chooseAccount` | new | `chooseAccount(target, root, name: string, env: AccountEnv): Promise<{ ok: true; resolved: ResolvedAccount } \| { ok: false; message: string }>` in `src/accounts/resolve.ts`. This is the explicit switch used by `/livespec account <name>`. It refuses when there is an env token, the name is unknown, or the account has no write access, and it stores on success | no |

**Session, command, doctor and card**

| Name | new / modified | Shape | public |
|---|---|---|---|
| `SessionDeps.accounts` | modified | `SessionDeps` gains `accounts: AccountEnv` (default `defaultAccountEnv()`). Test harnesses inject a fake `AccountEnv`, so hook tests never touch real `gh`, `tea` or the network | no |
| `Session.account` / `Session.accountBlock` | new | `account?: ResolvedAccount`; `accountBlock?: string`; `target?: ForgeTarget`; `accountNotice?: string`, consumed by `firstCardShown()`; `reconnect(): Promise<void>`; `switchAccount(name: string): Promise<{ ok: boolean; message: string }>`, which calls `chooseAccount` and then `reconnect` | no |
| `/livespec account [name]` | new | new subcommand; `USAGE` becomes `Usage: /livespec [validate \| migrate-openspec \| init \| doctor \| next \| account [name] \| skills <status\|update\|pin <sha>\|unpin\|rollback>]` | yes |
| Doctor check `forge-account` | new | registered with `registerDoctorCheck("forge-account", …)`. `DoctorDeps` (type in `src/commands/doctor.ts`) gains `account?: ResolvedAccount; accountBlock?: string` (read-only); `doctorDeps` in `src/commands/deps.ts` fills them from `sessionFor(cwd)` | yes |
| `CardInput.account` | modified | `CardInput` (in `src/hooks/phase-card.ts`) gains `account?: { line?: string; blocked?: string }`, filled by `buildCardInput` from `session.accountBlock` and `session.accountNotice`. `renderCard` stays pure. The notice is cleared only by `Session.firstCardShown()`, which the `context` hook calls after the model's first card; it clears `accountNotice` and also rewrites the cached `session.card.account` without `line`. So the UI-only resume render never consumes it, and the next card drops it even without a refresh | yes |
| Card section `forge-account` | new | registered with `registerCardSection("forge-account", (i) => …)`; it reads only `i.account` | yes |

---

## Task 1: Adapters accept an account — implements 1

**Covers:** 1.1, 1.2, 1.3, 1.4
**Difficulty:** Hard
**Blocked by:** none

**Files:**
- Modify: `src/forge/github.ts`, `src/forge/tea-config.ts`, `src/forge/gitea.ts`, `src/forge/gitea-transport.ts`, `src/forge/detect.ts`, `tests/forge/fake-gh/gh`, `tests/forge/fake-gh/state.ts`, `tests/forge/fake-gh/api.ts`, `tests/forge/github-world.ts`
- Test: `tests/forge/github.test.ts`, `tests/forge/gitea.test.ts`, `tests/forge/detect.test.ts`, `tests/forge/tea-config.test.ts` (new)

**Interfaces:**
- Produces: `ExecFn` (with `env`), `tokenEnvVar`, `GitHubForgeOptions.token`, `GiteaOptions.login`, `TeaLookup.login`, `findGiteaToken` (named and ambiguous), `teaLogins`, `DetectDeps.account`, `ForgeTarget`, `resolveForgeTarget`.

- [ ] **Step 1:** Write the tests in `tests/forge/github.test.ts`:
  - `Account token used`
  - `Enterprise host token`
  - `Token not in arguments`
  - `No token given`
  - `token with leading dash never reaches argv` (Review Focus 4)
  - `tokenEnvVar maps hosts`

  To support them and the later session tests, extend the executable fake `gh` (`tests/forge/fake-gh/`):
  - it records per call the env value of `GH_TOKEN`/`GH_ENTERPRISE_TOKEN` into state;
  - state `accounts: { login: string; token: string; push: boolean }[]`;
  - `gh auth status --hostname h --json hosts` lists those accounts;
  - `gh auth token --hostname h --user u` prints u's token;
  - `gh api user` and every mutation's author use the login of the request token, falling back to `data.login` when no token is sent;
  - `GET repos/{o}/{r}` answers `permissions.push` for that login.

  Run `bun run test tests/forge/github.test.ts`; expect FAIL.
- [ ] **Step 2:** Implement in `src/forge/github.ts`:
  - `createExec` passes `env: { ...process.env, ...env }` to `execFile` when `env` is given.
  - `tokenEnvVar`.
  - The adapter stores `token` and passes `{ [tokenEnvVar(hostname)]: token }` to every `run`.

  Run; expect PASS. The existing github tests and the contract suite stay green.
- [ ] **Step 3:** Write `tests/forge/tea-config.test.ts` and extend `tests/forge/gitea.test.ts`:
  - `Named login`
  - `Ambiguous logins`
  - `Named login missing`
  - `Named login for another host`
  - `teaLogins lists logins without spawning tea`
  - `malformed tea config gives no logins` (it feeds Review Focus 3)

  The baseline tests stay as they are: they cover `Token from environment`, `Token from tea config` and `No token`. Run; expect FAIL.
- [ ] **Step 4:** Implement `login` in `findGiteaToken`/`TeaLookup`, `teaLogins`, and the `GiteaOptions.login` pass-through in `gitea.ts` and `gitea-transport.ts`. Run; expect PASS.
- [ ] **Step 5:** Extend `tests/forge/detect.test.ts` with:
  - `Account passed to GitHub`;
  - `Account passed to Gitea`, asserting the `authorization` header carries that login's token, using an injected `teaConfigPath`;
  - `resolveForgeTarget returns the giteaUrl override and keeps the port`;
  - `Gitea by configured URL`;
  - `Gitea by tea SSH host`;
  - `tea SSH host shared by two URLs falls back to the probe`.

  Add `DetectDeps.teaLookup` so these tests inject the `tea` config path.

  Run; expect FAIL.

  Implement `DetectDeps.account`, and factor `resolveForgeTarget` out of `detectForge`. Detection behaviour stays identical, and the existing detect tests stay green. Run; expect PASS.
- [ ] **Step 6:** Run `bun run typecheck` and `bun run test`; expect PASS. Commit `feat(forge): adapters accept a per-clone account`.

---

## Task 2: Account discovery, access and storage — implements 2

**Covers:** 2.1, 2.2, 2.3, 2.4, 2.5
**Difficulty:** Normal
**Blocked by:** Task 1

**Files:**
- Create: `src/accounts/types.ts`, `src/accounts/env.ts` (`defaultAccountEnv`), `src/accounts/candidates.ts`, `src/accounts/token.ts`, `src/accounts/redact.ts`, `src/accounts/access.ts`, `src/accounts/store.ts`
- Test: `tests/accounts/candidates.test.ts`, `tests/accounts/access.test.ts`, `tests/accounts/store.test.ts`, `tests/accounts/redact.test.ts`, `tests/accounts/fakes.ts` (a fake `ExecFn` scripting `gh auth status --json`, `gh auth token`, `gh api repos/...`; a loopback fake for the Gitea repo endpoint)

**Interfaces:**
- Consumes: `ExecFn`, `tokenEnvVar`, `teaLogins` (Task 1); `GitExec` (`src/engine/git-exec.ts`).
- Produces: `AccountCandidate`, `Access`, `StoredAccount`, `AccountSource`, `SOURCE_LABEL`, `SelectionFacts`, `SelectionResult`, `AccountEnv`, `defaultAccountEnv`, `listCandidates`, `candidateToken`, `checkAccess`, `checkAll`, `ACCESS_TIMEOUT_MS`, `ACCESS_CONCURRENCY`, `redactTokens`, `readStored`, `writeStored`.

- [ ] **Step 1:** Write `tests/accounts/candidates.test.ts`:
  - `GitHub candidates`
  - `Gitea candidates`
  - `Gitea candidates behind an SSH host` (the target's web host differs from origin's)
  - `gh without json status gives no candidates and a reason` (Review Focus 2)
  - `malformed tea config gives no candidates` (Review Focus 3)

  Run; expect FAIL. Implement `listCandidates` with `gh auth status --hostname <host> --json hosts`, reading `hosts[host][].login`; the GitHub `user` equals `login`. Use `teaLogins` filtered by host. Run; expect PASS.
- [ ] **Step 2:** Write `tests/accounts/access.test.ts`:
  - `Push permission`
  - `Missing field`
  - `Unreachable`
  - `access check times out as unknown` (Review Focus 1)
  - `check uses the candidate token and not the active account` (asserts the token in env)
  - `at most four checks run at once`

  Run; expect FAIL. Implement `candidateToken`, `checkAccess` and `checkAll`. GitHub runs `gh api repos/{o}/{r} --hostname h` with the env token; Gitea runs `fetch` with `authorization: token …`. Run; expect PASS.
- [ ] **Step 3:** Write `tests/accounts/store.test.ts` against a temp repo:
  - `Stored locally`
  - `Global value ignored` (set `GIT_CONFIG_GLOBAL` to a temp file holding the keys)
  - `Unsafe value refused`
  - `values are written after --end-of-options`

  Run; expect FAIL. Implement it. Run; expect PASS.
- [ ] **Step 4:** Write `tests/accounts/redact.test.ts`: `redacts every known token` and `empty token list leaves text unchanged`. Implement it. Run; expect PASS.
- [ ] **Step 5:** Run typecheck and the full suite; commit `feat(accounts): discovery, access check and local storage`.

---

## Task 3: Pure selection — implements 3

**Covers:** 3.1
**Difficulty:** Normal
**Blocked by:** Task 2

**Files:**
- Create: `src/accounts/select.ts`
- Test: `tests/accounts/select.test.ts`

**Interfaces:**
- Consumes: the types from Task 2 (`SelectionFacts`, `SelectionResult`).
- Produces: `selectAccount`.

- [ ] **Step 1:** Write `tests/accounts/select.test.ts` as a table, one row per scenario, with the exact scenario names:
  - `Active account ignored` (facts never include an active flag; the row asserts the result from candidates alone)
  - `Tea default ignored`
  - `Environment token wins`
  - `Other forge's token ignored` (facts `envToken: false` for Gitea)
  - `Stored account reused`
  - `Single writer chosen automatically`
  - `Several writers with UI`
  - `Several writers without UI`
  - `No writer`
  - `Stale stored account`
  - `Stored account disappeared`
  - `Remote changed`
  - `Offline with stored account`
  - `Unknown stored account loses to a writer`
  - `Denied stored account not revived`

  Add `pure: equal inputs give deep-equal results`. Run; expect FAIL.
- [ ] **Step 2:** Implement `selectAccount` per design "Selection rules". Use one small function per rule and an ordered list, as `nextStep` does. Run; expect PASS.
- [ ] **Step 3:** Run typecheck and the full suite; commit `feat(accounts): pure account selection`.

---

## Task 4: Session integration and write block — implements 4

**Covers:** 4.1, 4.2, 4.3
**Difficulty:** Hard
**Blocked by:** Task 3

**Files:**
- Create: `src/accounts/resolve.ts`, `src/forge/redact.ts`
- Modify:
  - `src/hooks/session.ts`: `SessionDeps.accounts`, connect steps, `accountNotice`, `switchAccount`;
  - `src/hooks/card-input.ts`: fill `CardInput.account`;
  - `src/hooks/phase-card.ts`: `CardInput.account` type only;
  - `src/tools/guard.ts`;
  - `tests/hooks/helpers.ts`: a fake `AccountEnv` wired to the executable fake `gh` from Task 1 and a temp `tea` config;
  - `tests/hooks/fake-pi.ts`: a `ui.select` fake.
- Test: `tests/accounts/resolve.test.ts`, `tests/hooks/session-account.test.ts`, `tests/forge/redact.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 1–3;
  - LS-04: `Session`, `connectForge`, `applyAdvance`, `requireWritable`, `firstCardShown`, `buildCardInput`.
- Produces:
  - `ResolvedAccount`, `resolveAccount`, `chooseAccount`, `RedactingForge`;
  - `Session.account`, `Session.accountBlock`, `Session.accountNotice`, `Session.target`;
  - `Session.reconnect()`, `Session.switchAccount()`;
  - `SessionDeps.accounts`, `CardInput.account`.

- [ ] **Step 1:** Write `tests/accounts/resolve.test.ts`. It uses a fake `AccountEnv` and no adapter:
  - `Answer stored`
  - `Cancelled`
  - `ui select throwing is treated as cancelled` (Review Focus 5)
  - `env token gives source env without checking candidates`
  - `store happens only for store and ask results`
  - `notice names the account and why`
  - `messages are redacted`
  - `chooseAccount refuses with an env token, an unknown name, or no access`
  - `chooseAccount stores a writable account`

  Run; expect FAIL.

  Implement `resolveAccount` and `chooseAccount`:
  - gather the facts: stored, candidates, and `checkAll` only when the stored rule does not already decide;
  - call `selectAccount`;
  - ask through `select`;
  - store;
  - build the `notice`.

  Run; expect PASS.
- [ ] **Step 1b:** Write `tests/forge/redact.test.ts`: `RedactingForge redacts tokens in thrown errors of every operation`, using a stub forge whose methods throw `ForgeError`s containing the token. Implement `src/forge/redact.ts`. Run; expect PASS.
- [ ] **Step 2:** Write `tests/hooks/session-account.test.ts` using the hook harness, with the fake `gh` holding two accounts and a temp repo:
  - `First session`
  - `Later session`
  - `Uninitialized project`
  - `Shared by worktrees` (a second `git worktree add` of the temp repo)
  - `Confirmed candidate`
  - `Mismatch blocks writes`
  - `Refusal blocks writes`
  - `Automatic advance blocked`
  - `Identity unconfirmed`
  - `Environment identity outside the registry`: here, writes are allowed as `bot-account` and `session.account.user` is `bot-account`. The `/livespec account` output part is asserted in Task 5.
  - `Invalid environment token`: here, mutations are refused and `session.accountBlock` says the environment token was rejected. The card wording is asserted in Task 5.
  - `session errors after resolution contain no token` (a `whoami` failure echoing the token)
  - `account notice survives the resume render and is cleared after the first model card`. Run the resume entry, then two `context` calls with no refresh in between. Assert on `session.card.account` and `session.accountNotice`: the notice is present after the resume render, still present when the first `context` call builds its card, and absent from `session.card.account` before the second call. The block, if any, stays. The visible card text is asserted in Task 5 through the production section.

  Run; expect FAIL.
- [ ] **Step 3:** Implement the session wiring in `src/hooks/session.ts`. Keep `connectForge` small by splitting it into four steps:
  - `targetFor`: `resolveForgeTarget`;
  - `resolveSessionAccount`: `resolveAccount` with `deps.accounts` and `ctx.ui`;
  - `connectWithAccount`: `detectForge` with the account, wrapped `RedactingForge` → `CachedForge`;
  - `confirmIdentity`: `whoami` compared with the candidate user. With source env, a successful `whoami` is the identity. A failure sets `accountBlock`.

  Then:
  - `requireWritable` checks `session.accountBlock` first.
  - `applyAdvance` returns early when `session.accountBlock` is set.
  - `reconnect()` re-runs these steps.
  - `switchAccount(name)` calls `chooseAccount` and then `reconnect()`.
  - `firstCardShown()` also clears `accountNotice` and rewrites the cached `session.card.account`, dropping `line` and keeping `blocked`, so the next `context` call without a refresh no longer shows the notice.
  - `buildCardInput` fills `CardInput.account`.

  Run; expect PASS. The existing hook, tool and e2e tests stay green; update helpers so the existing tests run with a single writable account.
- [ ] **Step 4:** Run typecheck and the full suite; commit `feat(accounts): resolve the account at session start and block unconfirmed writes`.

---

## Task 5: Command, doctor and card — implements 5

**Covers:** 5.1, 5.2, 5.3
**Difficulty:** Normal
**Blocked by:** Task 4

**Files:**
- Create: `src/commands/account.ts`, `src/accounts/doctor.ts`, `src/accounts/card.ts`
- Modify:
  - `src/extension.ts`, `src/commands/subcommands.ts`;
  - `src/commands/doctor.ts`: `DoctorDeps.account` and `accountBlock` type;
  - `src/commands/deps.ts`: fill them from `sessionFor(cwd)`;
  - `tests/extension.test.ts`.
- Test: `tests/commands/account.test.ts`, `tests/accounts/doctor.test.ts`, `tests/accounts/card.test.ts`, `tests/accounts/secrets.test.ts`

**Interfaces:**
- Consumes: `Session.switchAccount`, `Session.account`, `Session.accountBlock`, `CardInput.account`, `SOURCE_LABEL`, `redactTokens`, `untrusted` (`src/hooks/phase-card.ts`), `registerDoctorCheck`, `registerCardSection`.
- Produces: `runAccountCommand(args: string, session: Session | undefined): Promise<string>`, the new `USAGE`, and the registered `forge-account` doctor check and card section.

- [ ] **Step 1:** Write `tests/commands/account.test.ts`:
  - `Show`
  - `Switch`
  - `Switch refused without access`
  - `Unknown name`
  - `Environment override`
  - `environment identity is shown with source environment` (completes the `Environment identity outside the registry` scenario)

  Update `tests/extension.test.ts` so the usage includes `account [name]`. Run; expect FAIL. Implement it. Run; expect PASS.
- [ ] **Step 2:** Write `tests/accounts/doctor.test.ts` and `tests/accounts/card.test.ts`:
  - `Doctor ok` (also asserts `.git/config` is byte-identical before and after)
  - `Doctor unverified`
  - `Doctor blocked`
  - `Card quiet in steady state`
  - `Card after automatic choice`
  - `Card after asked choice`
  - `Card when blocked`
  - `Untrusted forge text`
  - `card says the environment token was rejected` (completes `Invalid environment token`)
  - `notice text shows on the first model card only` (through the real extension: resume entry, then two `context` calls; the first card text has the account line, the second does not)
  - `doctor reads account state through command wiring` (`/livespec doctor` through the extension with a session holding a blocked account)

  Run; expect FAIL. Implement both registrations; they are imported for side effect from `src/extension.ts`. Run; expect PASS.
- [ ] **Step 3:** Write `tests/accounts/secrets.test.ts`:
  - `No token in arguments`: record every `ExecFn`/`GitExec` argv during a full session start plus `/livespec account`, and assert no token appears.
  - `No token in output on failure`: three failures that each echo the token:
    - a candidate check;
    - a `whoami` after resolution;
    - a tool mutation after resolution (`spec_write`).

    The token must be absent from the errors, `session.errors`, the builtin doctor `forge` result, the `forge-account` doctor result, the card, and the tool result content and details.

  Run; expect PASS. If one fails, fix the leak in the owning module.
- [ ] **Step 4:** Run typecheck and the full suite; commit `feat(accounts): account command, doctor check and card notice`.

---

## Task 6: Docs, manual check and suite — implements 6

**Covers:** 6.1, 6.2, 6.3
**Difficulty:** Easy
**Blocked by:** Task 5

**Files:**
- Modify: `docs/architecture.md`, `README.md` (only if it mentions forge auth)
- Create: `openspec/changes/forge-accounts/smoke.md`

- [ ] **Step 1:** Update `docs/architecture.md`:
  - forge accounts are chosen per clone (`livespec.account` in `.git/config`);
  - how the account is selected;
  - subprocess tokens are passed through the per-call env, and HTTP tokens through the authorization header, never in argv or on disk.
- [ ] **Step 2 (parent, manual):** Run a real pi session with livespec loaded in a scratch clone of `ttdua/pi-livespec`.
  - **Setup:** initialized config. Make `naicoi92` the active `gh` account only inside a scratch `GH_CONFIG_DIR` copy, so the real config is not switched.
  - **Expect:**
    - `ttdua` is selected and stored;
    - `/livespec account` shows source `automatic`;
    - a `gh api user` made through the session forge returns `ttdua`.

  Record it in `openspec/changes/forge-accounts/smoke.md`.
- [ ] **Step 3:** Run `bun run typecheck` and `bun run test`; expect PASS. Commit `docs: forge accounts per clone`.

---

## Scenario → test

**forge-accounts:**
- Stored locally, Global value ignored, Unsafe value refused → `tests/accounts/store.test.ts`
- Shared by worktrees, First session, Later session, Uninitialized project, Confirmed candidate, Mismatch blocks writes, Refusal blocks writes, Automatic advance blocked, Identity unconfirmed → `tests/hooks/session-account.test.ts`
- Tea default ignored, Active account ignored, Environment token wins, Other forge's token ignored, Stored account reused, Single writer chosen automatically, Several writers with UI, Several writers without UI, No writer, Stale stored account, Stored account disappeared, Remote changed, Offline with stored account, Unknown stored account loses to a writer, Denied stored account not revived → `tests/accounts/select.test.ts`
- GitHub candidates, Gitea candidates, Gitea candidates behind an SSH host → `tests/accounts/candidates.test.ts`
- Push permission, Missing field, Unreachable → `tests/accounts/access.test.ts`
- Answer stored, Cancelled → `tests/accounts/resolve.test.ts`
- Environment identity outside the registry → `tests/hooks/session-account.test.ts`, plus the command output in `tests/commands/account.test.ts` "environment identity is shown with source environment"
- Invalid environment token → `tests/hooks/session-account.test.ts`, plus the card wording in `tests/accounts/card.test.ts` "card says the environment token was rejected"
- Show, Switch, Switch refused without access, Unknown name, Environment override → `tests/commands/account.test.ts`
- Doctor ok, Doctor unverified, Doctor blocked → `tests/accounts/doctor.test.ts`
- Card quiet in steady state, Card after automatic choice, Card after asked choice, Card when blocked, Untrusted forge text → `tests/accounts/card.test.ts`
- No token in arguments, No token in output on failure → `tests/accounts/secrets.test.ts`

**github-adapter:**
- Not logged in → existing `tests/forge/github.test.ts` "gh auth status failure throws auth naming the operation"
- Identity → existing `tests/forge/github.test.ts` "whoami reads the login from gh api user"
- Account token used, Enterprise host token, Token not in arguments, No token given → `tests/forge/github.test.ts` (new)

**gitea-adapter:**
- Token from environment, Token from tea config, No token → existing `tests/forge/gitea.test.ts` ("comes from GITEA_TOKEN", "comes from the tea config login for the host, without spawning tea", "is an auth error naming the operation when none is found")
- Named login, Ambiguous logins, Named login missing, Named login for another host → `tests/forge/gitea.test.ts` / `tests/forge/tea-config.test.ts` (new)

**forge-interface:**
- GitHub remote → existing `tests/forge/detect.test.ts` "selects GitHub for a github.com remote without probing"
- Gitea by config → existing "selects Gitea by config without probing"
- Gitea by probe → existing "selects Gitea when the origin host answers the version probe"
- Unknown host → existing "throws unsupported naming the host for an unknown host"
- Account passed to GitHub, Account passed to Gitea, Gitea by configured URL, Gitea by tea SSH host → `tests/forge/detect.test.ts` (new)
