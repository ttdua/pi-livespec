## Why

A machine often holds several `gh` accounts and several `tea` logins for one host. livespec now uses whichever `gh` account is active machine-wide, or the first `tea` login that matches the host. A switch in another terminal, or an admin token listed first, silently changes who livespec writes as. Only own marked comments count as state, so a wrong identity loses counters, notes and gates. The user wants the account chosen per repository and handled by livespec, not by a global setting or a command to remember.

## What Changes

- **New capability `forge-accounts`:**
  - list the candidate accounts for the `origin` host, from `gh auth status` or the `tea` logins;
  - ask the forge which candidates can write to the repository;
  - store the choice in the clone's local git config (`livespec.account`, `livespec.accountRemote`);
  - re-select when the stored value goes stale;
  - ask once through the UI only when several accounts can write;
  - refuse writes, and explain why, when no choice can be made;
  - add `/livespec account [name]`, a doctor check and a phase-card notice.

**GitHub transport and auth**
- From: `gh api` runs as the account that is active for the host.
- To: when an account is given, every `gh` call runs with that account's token in `GH_TOKEN`, taken from `gh auth token --user`. With no account, behaviour is unchanged.
- Reason: a machine-wide `gh auth switch` must not change livespec's identity.
- Impact: additive and non-breaking. `ExecFn` gains an optional `env` argument.

**Gitea transport and auth**
- From: `GITEA_TOKEN`, or else the first `tea` login whose URL host matches.
- To: `GITEA_TOKEN`, or else the `tea` login named by the selected account. If several logins match and none is named, it is refused, never picked by order.
- Reason: with two logins on one host, file order decided, and it could be an admin token.
- Impact: changes behaviour only for hosts with several matching logins and no selected account.

**Forge detection**
- From: `detectForge` chooses the adapter only. For Gitea it needs config or a successful probe of the `origin` host. A self-hosted Gitea whose git SSH host differs from its web host (`ssh.gitea.example.org` vs `gitea.example.org`) is only found through `giteaUrl` in config.
- To:
  - `detectForge` also accepts the selected account and passes it to the adapter.
  - The Gitea web URL stays configurable for any domain (`forge: gitea` with `giteaUrl` or `host`).
  - Without config, an `origin` host that equals a `tea` login's `ssh_host` maps to that login's URL.
- Reason: the account is chosen per clone before the adapter is built. Self-hosted servers sit on their own domains, with their own SSH hosts (user review).
- Impact: additive.

Out of scope:
- Forges other than GitHub and Gitea.
- Storing tokens. livespec never writes tokens anywhere.
- Changing the AGENTS.md routine for manual `gh` use; that is recommended in design only.

## Capabilities

### New Capabilities
- `forge-accounts`: covers how the forge account is chosen per clone:
  - candidate discovery and the write-access check;
  - local git config storage and re-selection;
  - asking once when ambiguous;
  - refusing writes on an identity mismatch;
  - the `/livespec account` command, the doctor check and the card notice.

### Modified Capabilities
- `github-adapter`: *GitHub transport and auth*. The adapter runs `gh` with the selected account's token when one is given.
- `gitea-adapter`: *Gitea transport and auth*. The token comes from the named `tea` login, and an ambiguous host without a name is refused.
- `forge-interface`: *Forge detection*. Detection takes the selected account and passes it on.

## Impact

- **New code:** `src/accounts/` and `src/commands/account.ts`.
- **Changed LS-03 code:** `src/forge/github.ts` (token env), `src/forge/tea-config.ts` (named login, ambiguity), `src/forge/gitea.ts` and `gitea-transport.ts` (login option), `src/forge/detect.ts` (account pass-through).
- **Changed LS-04 code:** `src/hooks/session.ts` (selection before connecting), `src/extension.ts` (new subcommand and usage), and registrations through `registerDoctorCheck` and `registerCardSection`.
- **Dependencies:** none new. Selection runs the `git` and `gh` binaries and reads the `tea` config, which the project already relies on.
- **Behaviour on this machine:** GitHub selects `ttdua` for `ttdua/pi-livespec` automatically. For `gitea.example.org`, livespec asks once if both logins can write.
- **Base:** builds on LS-04 (PR #15). This change's branch is cut from `ls-04` and merges after it.
