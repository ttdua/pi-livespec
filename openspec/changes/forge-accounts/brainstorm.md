## Design Summary

A machine often has several forge accounts: several `gh` logins on `github.com` (here `ttdua` and `naicoi92`), and several `tea` logins for the same Gitea host (here `gitea.example.org` and `gitea-admin`, both on `https://gitea.example.org`). Today livespec guesses which one to use:

- **GitHub:** the adapter runs `gh api` with no account, so it uses whichever account is active for the host. That is machine-wide state. A `gh auth switch` in another terminal changes livespec's identity in the middle of a session.
- **Gitea:** the adapter uses `GITEA_TOKEN`, or else the first `tea` login whose URL matches the host. With two logins on one host, the order in the file decides, and it can silently be an admin token.

Because only own marked comments count as state (`forge-markers` / *Only own marked comments count*), a wrong or changing identity makes counters, skill notes and later gate comments disappear or land under another account.

The user does not want a machine-wide (global) setting. The account belongs to each repository clone, and pi-livespec must handle it itself, without the user having to remember a command.

What the user and the agent get:

- **Per-clone account.** The chosen account is stored in the clone's local git config, as `livespec.account` plus `livespec.accountRemote` (the remote it was chosen for). It is never committed, it is shared by every worktree of the clone, and it disappears with the clone. There is no user-level or global setting.
- **Automatic selection at session start.** livespec lists the candidate accounts for the `origin` host: the `gh` accounts for a GitHub host, or the `tea` logins whose URL matches for a Gitea host. It asks the forge, with each candidate's token, whether that account can write to the repository.
  - **One account can write:** livespec saves it and says so in one line, for example "livespec uses `ttdua` for this repository".
  - **Several accounts can write:** livespec asks once through the interactive UI, lists them, and saves the choice. Without a UI, writes are refused, and the card and doctor say how to choose.
  - **No account can write:** the forge is read-only, and the card says how to log in (`gh auth login`, `tea login add`).
- **Re-selection when the stored value goes stale.** The stored account is checked again when it no longer has write access, has disappeared, or `origin` now points elsewhere (`livespec.accountRemote` differs).
- **Isolation from machine-wide switches.** GitHub calls run with that account's token in `GH_TOKEN`, taken from `gh auth token --user <account>` and held in memory only. Gitea uses the named `tea` login's token. After selection, `whoami` must equal the chosen account, or writes are refused.
- **Visibility.** The new command `/livespec account [name]` shows the account in use and its source, or switches to another account. Doctor reports the account in use, how it was chosen, and candidates that were left out. It writes nothing.
- **`GITEA_TOKEN` and `GH_TOKEN` set by the user still win.** That is an explicit per-process choice, not a global guess. Doctor reports it as the source.

### Existing requirements involved

These are altered on purpose:

- **`github-adapter` / *GitHub transport and auth*.** It says calls go through `gh api` and the auth check uses `gh auth status`. The adapter will also accept an account and run `gh` with that account's token. `gh auth status` stays the check when no account is given.
- **`gitea-adapter` / *Gitea transport and auth*.** It says the token comes from `GITEA_TOKEN` or the `tea` config. The `tea` lookup becomes "the named login", and a host with several matching logins and no chosen name is refused instead of picking the first one.
- **`forge-interface` / *Forge detection*.** `detectForge` chooses the adapter. It will also take the selected account and pass it to the adapter.

These are not altered:

- `forge-markers` / *Only own marked comments count* is unchanged. This change keeps the current login stable, which is what that rule depends on.
- `forge-cache`, the read-only mode, is reused for "no account can write".
- From the open LS-04 change (PR #15), `init-and-doctor` and `context-injection` are not edited (user decision). The new behavior lives in a new capability `forge-accounts` and plugs into the existing `registerDoctorCheck` and `registerCardSection` seams.

## Alternatives Considered

### Alternative A: Per-clone local git config, auto-selected (chosen)
- **Approach**: livespec detects candidates, checks write access per candidate, saves the choice in `.git/config` (`livespec.account`), and asks only when several can write.
- **Pros**: Not global. No new file. Not committed. Shared by all worktrees of a clone. The user does nothing in the common case.
- **Cons**: One extra API call per candidate when the stored value is missing or stale. livespec writes to the clone's git config.
- **Why not chosen**: It is chosen.

### Alternative B: Gitignored file `.pi/livespec/config.local.yaml`
- **Approach**: Store the account in a local, untracked project file.
- **Pros**: Sits next to the project config.
- **Cons**: A new file and gitignore rule. Each worktree needs its own copy or a copy hook.
- **Why not chosen**: Worse with worktrees, which this workflow uses for every task.

### Alternative C: Per-directory environment (`.envrc` with `GH_TOKEN`/`GITEA_TOKEN`)
- **Approach**: Rely on direnv to set a token per directory.
- **Pros**: No livespec change.
- **Cons**: Tokens in a file. Depends on direnv. Each worktree is set up by hand. Nothing detects or explains a wrong account.
- **Why not chosen**: It puts the burden on the user, which they explicitly rejected.

### Alternative D: User-level `forgeAccounts` map in `~/.pi/agent/livespec/config.yaml`
- **Approach**: One map from host or owner to account for the whole machine.
- **Pros**: One place to edit.
- **Cons**: Global, which the user rejected.
- **Why not chosen**: User decision.

## Agreed Approach

Alternative A.

- **Where:** a new capability `forge-accounts` holds account discovery, selection, storage, the `/livespec account` command, the doctor check and the card notice. The adapters and detection gain an account input through deltas to the three LS-03 living specs.
- **When several accounts can write:** livespec asks once through the UI at session start and saves the answer. It never prefers the machine's "active" or "default" account, because that is global state.
- **Agent rule:** the AGENTS.md "switch the gh account" routine is no longer needed for livespec operations. Manual commands can use `GH_TOKEN=$(gh auth token -u <account>) gh …` per command instead of `gh auth switch`.

## Key Decisions

- **Storage is the clone's local git config** (user decision). Keys are `livespec.account` and `livespec.accountRemote`, written with `git config --local`.
- **No global setting** (user decision). Neither the user config nor the active or default account is used to choose among several writable candidates.
- **Automatic selection; ask once only when several can write** (user decision). Without a UI, livespec refuses writes and explains.
- **New capability `forge-accounts`** (user decision), plus MODIFIED requirements in `github-adapter`, `gitea-adapter` and `forge-interface`. `init-and-doctor` and `context-injection` are not edited.
- **Write access is decided by the forge** (my call). GitHub uses `GET /repos/{owner}/{repo}` → `permissions.push` with the candidate's token. Gitea uses `GET /api/v1/repos/{owner}/{repo}` → `permissions.push`. This was verified on this machine: `ttdua` → true, `naicoi92` → false for `ttdua/pi-livespec`.
- **An explicit environment token wins** (my call). `GH_TOKEN` or `GITEA_TOKEN` in the environment bypasses selection, and doctor shows "from environment".
- **Tokens are never stored by livespec** (my call). They are read from `gh` or the `tea` config when needed and kept in memory only.
- **Session start writes the clone's git config** (my call). This is a new kind of automatic write. It is local, uncommitted and announced each time. Doctor still writes nothing.

## Open Questions

- None blocking. `design.md` decides how candidates are listed (`gh auth status --json hosts`, `tea` config logins), the timeouts of the per-candidate checks, and whether `/livespec init` also runs the selection.
