## Context

LS-03 built two adapters and LS-04 wires them in at session start:
- `GitHubForge` (`src/forge/github.ts`) runs `gh` through `ExecFn(file, args, input?)`, which has no environment argument. It checks authentication with `gh auth status`.
- `GiteaForge` (`src/forge/gitea.ts`, `gitea-transport.ts`) resolves a token once through `findGiteaToken` (`src/forge/tea-config.ts`): `GITEA_TOKEN`, or else the first `tea` login whose URL host matches.
- In LS-04, `connectForge` (`src/hooks/session.ts:176`) calls `detectForge`, wraps the result in `CachedForge` and builds the `CommentsCache`.
- The write tools refuse through `requireWritable` (`src/tools/guard.ts:45`).
- Doctor and the phase card accept extra checks and sections through `registerDoctorCheck` and `registerCardSection`.

Facts checked on this machine:
- `gh auth status --json hosts` lists every account per host with `login`, `active` and `state`.
- `gh auth token --hostname <h> --user <u>` prints that account's token. `GH_TOKEN=<token> gh api user` returns that account, whatever account is active.
- `GET repos/ttdua/pi-livespec` returns `permissions.push = true` with `ttdua`'s token and `false` with `naicoi92`'s.
- The `tea` config (`~/Library/Application Support/tea/config.yml` on macOS) lists `logins[]` with `name`, `url`, `token`, `user` and `default`. Here two logins share `https://gitea.example.org`.

## Goals / Non-Goals

**Goals:**
- Each clone uses one known account per forge, chosen without the user remembering a command.
- No machine-wide state (the active `gh` account, the `tea` default, user config) decides between several writable accounts.
- A wrong or unconfirmed identity can never write.

**Non-Goals:**
- Choosing a forge, which `detectForge` still does.
- Storing or rotating tokens.
- GitLab and other forges.
- Changing how a human uses `gh` outside livespec.

## Decisions

### Self-hosted Gitea domains

A self-hosted Gitea often has two names. Git goes over SSH (`ssh.gitea.example.org`), and the web and API are elsewhere (`https://gitea.example.org`). The real server here is like that. Detection resolves one `ForgeTarget` with the web host and `baseUrl`. Account discovery, access checks and the adapter all use that target, never the raw `origin` host.

Order for Gitea:
1. **Project config**, the existing keys:
   - `forge: gitea` with `giteaUrl: https://gitea.example.org` (any domain, any port, http or https);
   - or with `host: gitea.example.org` (https assumed).
2. **The `tea` SSH host:** when there is no Gitea config and `origin`'s host equals some `tea` login's `ssh_host`, the web URL is that login's `url`. The match is exact, case-insensitive, and the port is ignored. If several logins share the `ssh_host` with different URLs, no guess is made, and detection falls through to the probe.
3. **The existing probe** of `origin`'s host (`/api/v1/version`).

Only the domain list is configurable. No domain is hard-coded, and the config lives in the project file the project already has. That is per repository, not global.

### Module layout

```text
src/accounts/
  types.ts         AccountCandidate, AccountChoice, AccountSource, SelectionResult
  candidates.ts    listGitHubCandidates(target.host) via `gh auth status --json hosts`;
                   listGiteaCandidates(target.baseUrl) from the tea logins whose URL host
                   equals the target's web host
  access.ts        canWrite(candidate, repo): GitHub `gh api repos/{o}/{r}` with the
                   candidate's token in tokenEnvVar(host); Gitea GET /api/v1/repos/{o}/{r}
  store.ts         readStored / writeStored over `git config --local livespec.account*`
  select.ts        selectAccount(input) — pure decision over facts
  resolve.ts       resolveAccount(deps): gathers facts, calls selectAccount, asks or stores
  token.ts         githubToken(host, login) via `gh auth token`; giteaToken(login) from config
src/commands/account.ts   /livespec account [name]
src/accounts/doctor.ts    registerDoctorCheck("forge-account", …)
src/accounts/card.ts      registerCardSection("forge-account", …)
```

The decision is a pure function, `selectAccount(facts) → result`. Fact gathering (`gh`, `tea` config, HTTP, git config) and side effects (asking, storing, notifying) live in `resolve.ts`, so the decision is table-tested with no I/O. Each file has one job.

### Selection rules (pure)

**Input:**
- `env`: the environment token of the forge in use is present (`tokenEnvVar(host)` for GitHub, `GITEA_TOKEN` for Gitea);
- `stored`: `{ account, remote }` or none;
- `remote`: the current `host/owner/repo`;
- `candidates[]`, each with `name` (the `gh` login or `tea` login name), `user` and `canWrite: true | false | unknown`;
- `hasUI`.

**Rules, first match wins:**
1. The environment token of the forge in use is set → `{ kind: "env" }`. No selection, and nothing is stored. Doctor shows the source.
   - **GitHub:** `GH_TOKEN`, or `GH_ENTERPRISE_TOKEN` for an Enterprise Server host.
   - **Gitea:** `GITEA_TOKEN`.
   - A token for the other forge does not count.
2. `stored` exists, `stored.remote` equals `remote`, the stored candidate exists, and its `canWrite` is `true` → `{ kind: "use", account, source: "stored" }`.
3. Exactly one candidate has `canWrite: true` → `{ kind: "store", account, source: "auto" }`.
4. Several candidates have `canWrite: true`:
   - with a UI → `{ kind: "ask", options }`;
   - without one → `{ kind: "refuse", reason: "ambiguous", options }`.
5. No candidate has `canWrite: true`:
   - if the stored account matches the remote, is still a candidate, and its own `canWrite` is `unknown` → `{ kind: "use", source: "stored", unverified: true }`;
   - otherwise → `{ kind: "refuse", reason: "no-access" | "no-candidates" | "unreachable" }`.

   Another candidate being `unknown` never revives a stored account that is `false` or missing.

A stored account that is no longer a candidate, or whose `canWrite` is `false`, falls through to rules 3–5. That is the re-selection. A remote mismatch (`stored.remote` ≠ `remote`) does the same.

### Checking write access

- **GitHub:** `gh api repos/{o}/{r} --jq .permissions.push`, run with the candidate's token in `tokenEnvVar(host)` and `--hostname <host>`. The token comes from `gh auth token --hostname <host> --user <login>`.
- **Gitea:** `GET /api/v1/repos/{o}/{r}` with the login's token, then read `permissions.push`.
- **Outcomes:**
  - `permissions.push: false`, or HTTP 401, 403 or 404 → `false`;
  - a response without `permissions` (some fine-grained tokens), a network failure, or a timeout (5 s per candidate) → `unknown`.
- **Unknown is never write access.** It can only keep the stored account unverified (rule 5).
- **Order:** candidates are checked in parallel, with a cap of 4. The check runs only when rule 2 does not already apply, so a stable clone pays nothing after the first session. Rule 2 still re-checks the stored candidate once per session: one call.

### Storage in git config

- **Writes:**
  - `git config --local livespec.account <name>`
  - `git config --local livespec.accountRemote <host>/<owner>/<repo>`
- **Reads:** `git config --local --get`, exit 1 → none. The global and system configs are never consulted.
- **Safety:** every operand goes after `--end-of-options`, following the LS-04 git-wrapper rule. Values are checked before storing:
  - a `gh` login uses `[A-Za-z0-9-]`;
  - a `tea` login name has no control characters and is at most 100 characters.
- **Scope:** `--local` is the common `.git/config`, so every worktree of the clone shares it. This is intended: one account per clone.

### Asking once

`ctx.ui.select(title, labels)` is used when `ctx.hasUI` is true. LS-01 probe (j) verified that the extension gets the human's answer directly.
- **Labels:** `<name> (<user>) — can push`.
- **Answer:** the chosen name is stored at once with source `asked`.
- **Cancelled:** treated as rule 4 without a UI, so writes are refused and the card explains `/livespec account <name>`.
- **When:** the question is asked during `session_start` after the forge is detected. It is awaited, but only on this path. Every other path is non-blocking.

### Adapters receive the account

- **`ExecFn`:** gains an optional fourth parameter, `env?: Record<string, string>`, merged over `process.env` for that run. `createExec` passes it to `execFile`. Existing callers are unchanged.
- **`GitHubForgeOptions`:** gains `token?: string`.
  - When set, every `gh` call (`api` and `auth status`) passes the token in the environment variable `gh` reads for the host.
  - `tokenEnvVar(hostname)`: `github.com` and `*.ghe.com` → `GH_TOKEN`; any other host (Enterprise Server) → `GH_ENTERPRISE_TOKEN`.
  - The same helper is used by the write-access check.
  - `ensureAuth` keeps `gh auth status` and adds that env.
  - The adapter never runs `gh auth switch`.
- **`GiteaOptions` and `TeaLookup`:** gain `login?: string`.
  - `findGiteaToken` returns `GITEA_TOKEN`, or else the named login's token, or else the single login whose URL host matches.
  - A named login must also have a URL host equal to the server's host. If it does not, `ForgeError("auth")` is thrown before any request.
  - Several logins match and none is named → `ForgeError("auth")` with the message "several tea logins for <host>: a, b; choose one with /livespec account <name>".
- **`detectForge(repoRoot, deps)`:** deps gain `account?: { name: string; token?: string }`. Detection passes `token` to `GitHubForge` and `name` (as `login`) to `GiteaForge`.

### Session wiring (LS-04 integration)

`connectForge` becomes:
1. `detectForge` without an account, used only to learn the kind and host;
2. `resolveAccount`;
3. if an account was chosen, `detectForge` again with it, so the adapter is built once with credentials;
4. the `CachedForge` wrap;
5. `whoami()`:
   - **Chosen candidate:** the result is compared with the candidate's `user`.
   - **Environment source:** a successful `whoami()` alone establishes the identity in use; the token's account need not be in any registry. Doctor and `/livespec account` show that login with source `environment`.
   - A mismatch, a `whoami()` failure or a refusal sets `session.accountBlock = reason`.
   - `requireWritable` refuses with that reason.
   - `applyAdvance` checks `session.accountBlock` before calling `advancePhase`, so automatic writes are blocked too.
   - The block is independent of `CachedForge` read-only mode. A successful read never clears it; only a new selection or `/livespec account <name>` does.
   - Reads still work, so the card can render.

The selection runs only when the project is initialized (`session.initialized`). `resolveAccount` sends one notice whenever it writes the git config: "livespec uses `<name>` for this repository (chosen automatically)" or "(you chose it)".

The tools run in the same process and use the session's forge, so they get the account without extra wiring.

### `/livespec account [name]`

- **No argument:** prints the host, the account in use, its source as a label: internal `env` / `stored` / `auto` / `asked` shown as `environment` / `stored` / `automatic` / `asked`, the stored remote and every candidate with its access.
- **With a name:** checks write access for that candidate, stores it, rebuilds the session forge (`session.reconnect()`) and prints the result.
  - A candidate without access, or a name that is not a candidate, is refused.
  - While the environment token of the forge in use is set, every switch is refused with an explanation, because the environment decides.

### Doctor and card

- **Doctor check `forge-account`:**
  - `ok`: the account and its source;
  - `warn`: unverified because the forge was unreachable;
  - `error`: a block, with the reason and the exact `/livespec account` line.
  - Doctor never writes: the check reads the session's last resolution or calls `selectAccount` on freshly gathered facts, and never calls the store.
- **Card section `forge-account`:** one line, shown only when writes are blocked, or on the first card after an automatic or asked choice. For example: "livespec uses `ttdua` for this repository (chosen automatically)". In steady state the card is unchanged, which keeps it stable.

### Tokens

Tokens stay in memory, in the adapter instance. They are never written to disk, the cache or messages, and never passed to the model. Passing a token through the environment keeps it off argv, but that alone does not guarantee it stays out of output.

- **Redaction:** every message the account flow builds goes through `redactTokens(text, knownTokens)`, which replaces each known token with `***`. This covers errors from `gh` stderr and HTTP bodies.
- **Untrusted wrapping:** registered card sections are appended verbatim, so the account section wraps forge-reported logins and error text with `untrusted()` itself.

## Risks / Trade-offs

- [The extra `gh` and HTTP calls at the first session of a clone] → in parallel, 5 s cap each, and later sessions pay only one call.
- [The session writes `.git/config`] → local and uncommitted, announced each time, values validated, operands option-safe.
- [Fine-grained PATs can lack `permissions` in the repo response] → a missing field is treated as `unknown`, never as `true`. With no writable candidate, a stored account whose own check is `unknown` is kept unverified; otherwise writes are refused. Only candidates that can write are offered in the question.
- [`ui.select` blocks session start until answered] → only on the ambiguous path, once per clone. Cancelling gives a readable refusal, not a hang.
- [Two worktrees of a clone starting at the same moment both store] → both store the same deterministic answer (auto) or the human's answer (asked). The last write wins with an equal or user-chosen value. Accepted.
- [`GH_TOKEN` set in the user's shell] → rule 1 respects it. Doctor makes it visible, so a surprising identity is explained.

## Migration Plan

Existing clones have no stored account. The first session runs the selection. On this machine, GitHub chooses `ttdua` with no prompt. Rolling back the code leaves two harmless keys in `.git/config`.

## Open Questions

- None blocking. `/livespec init` does not run the selection itself, because the next session start does.
