# forge-accounts Specification

## Purpose

Defines how livespec chooses the forge account per clone: candidate discovery, the write-access check, local git config storage and re-selection, asking once when ambiguous, identity confirmation, blocking writes when no account can be used, the `/livespec account` command, the doctor and card report, and secret handling.

## Requirements

### Requirement: Per-clone account storage
The account livespec uses for a repository SHALL be stored only in the clone's local git config, as `livespec.account` (the `gh` login or `tea` login name) and `livespec.accountRemote` (`<host>/<owner>/<repo>` of `origin` when it was chosen). Both keys MUST be read and written with `git config --local`, so a value in the user's global or system git config is never used. Tokens MUST NOT be stored.

#### Scenario: Stored locally
- **WHEN** an account is chosen for a clone
- **THEN** `git config --local --get livespec.account` returns it, `livespec.accountRemote` holds the origin, and no file outside the clone's `.git/config` changes

#### Scenario: Global value ignored
- **WHEN** the user's global git config has `livespec.account=naicoi92` and the clone's local config has none
- **THEN** the selection treats the account as not stored

#### Scenario: Shared by worktrees
- **WHEN** an account is stored from one worktree, and a session starts in another worktree of the same clone with the same origin, while the account can still push
- **THEN** the second session uses the stored account without selecting again

#### Scenario: Unsafe value refused
- **WHEN** a candidate name contains a newline or starts with `-`
- **THEN** it is not stored and the selection reports it as invalid

### Requirement: No machine-wide preference
livespec MUST NOT use any user-level or machine-wide preference to choose between candidates: not the livespec user config, not the active `gh` account, not the `tea` default flag.

#### Scenario: Tea default ignored
- **WHEN** `GITEA_TOKEN` is unset, no valid account is stored, two `tea` logins for the host can push, one marked `default: true`, and a UI exists
- **THEN** the user is asked to choose between both, and neither is picked because of the default flag

### Requirement: Candidate discovery
livespec SHALL list the candidates for the detected forge target's web host, which may differ from the `origin` host: for GitHub, every account `gh auth status --json hosts` lists for that host; for Gitea, every `tea` login whose URL host equals that web host. Only the active or default markers of these registries are ignored. A candidate MUST carry its name and the forge user it authenticates as.

#### Scenario: GitHub candidates
- **WHEN** `gh` has accounts `ttdua` and `naicoi92` on `github.com`
- **THEN** both are candidates for a `github.com` remote

#### Scenario: Gitea candidates
- **WHEN** the `tea` config has logins `gitea.example.org` and `gitea-admin` with URL `https://gitea.example.org`, and a login `other` for another host
- **THEN** the first two are candidates for a remote on `gitea.example.org` and `other` is not

#### Scenario: Gitea candidates behind an SSH host
- **WHEN** `origin` is `git@ssh.gitea.example.org:acme/shop.git` and the forge target's web host is `gitea.example.org`
- **THEN** the `tea` logins with URL `https://gitea.example.org` are the candidates

### Requirement: Write access check
For each candidate considered, livespec SHALL ask the forge with that candidate's own credentials whether it can push to the repository, and record `true`, `false` or `unknown`. `permissions.push: false`, HTTP 401, 403 or 404 MUST count as `false`. A response without a `permissions` field, a network failure or a timeout MUST count as `unknown`. The check MUST NOT change the active `gh` account.

#### Scenario: Push permission
- **WHEN** the repository reports `permissions.push: true` for `ttdua` and `false` for `naicoi92`
- **THEN** `ttdua` is `true` and `naicoi92` is `false`

#### Scenario: Missing field
- **WHEN** the repository response has no `permissions` field
- **THEN** the candidate is `unknown`

#### Scenario: Unreachable
- **WHEN** the forge cannot be reached while checking a candidate
- **THEN** that candidate is `unknown`

### Requirement: Account selection
The selection SHALL be a pure function of the facts: the environment token for the forge in use, the stored account and remote, the current remote, the candidates with their access, and whether a UI exists. The active `gh` account and the `tea` default flag MUST NOT influence the result.

#### Scenario: Active account ignored
- **WHEN** no environment token is set, nothing is stored, `naicoi92` is the active `gh` account, and only `ttdua` can push
- **THEN** `ttdua` is selected

### Requirement: Environment token override
When the environment token of the forge in use is set (`GH_TOKEN`, or `GH_ENTERPRISE_TOKEN` for an Enterprise Server host, for GitHub; `GITEA_TOKEN` for Gitea), the selection SHALL use it and store nothing. A token for the other forge MUST NOT count.

#### Scenario: Environment token wins
- **WHEN** the remote is on `github.com` and `GH_TOKEN` is set
- **THEN** the result is "environment" and nothing is stored

#### Scenario: Other forge's token ignored
- **WHEN** the remote is on `gitea.example.org` and only `GH_TOKEN` is set
- **THEN** the selection runs normally over the `tea` logins

#### Scenario: Environment identity outside the registry
- **WHEN** the remote is on `github.com`, `GH_TOKEN` belongs to an account that `gh auth status` does not list, and `whoami()` returns `bot-account`
- **THEN** writes are allowed as `bot-account` and `/livespec account` shows `bot-account` with source `environment`

#### Scenario: Invalid environment token
- **WHEN** the remote is on `github.com`, `GH_TOKEN` is set, but `whoami()` fails with an `auth` error
- **THEN** every forge mutation is refused and the card says the environment token was rejected

### Requirement: Selection rules
Without an environment token, the first matching rule MUST decide: (1) the stored account matches the current remote, is still a candidate and is `true`: use it; (2) exactly one candidate is `true`: store and use it; (3) several are `true`: ask with a UI, else refuse writes; (4) the stored account matches the remote, is still a candidate and is itself `unknown`: use it unverified; otherwise refuse writes.

#### Scenario: Stored account reused
- **WHEN** no environment token is set, `livespec.account` is `ttdua`, its remote matches, and `ttdua` is a candidate that can push
- **THEN** the result is "use `ttdua` (stored)"

#### Scenario: Single writer chosen automatically
- **WHEN** no environment token is set, nothing is stored, and only `ttdua` can push
- **THEN** `ttdua` is stored and the result says it was chosen automatically

#### Scenario: Several writers with UI
- **WHEN** no environment token is set, nothing is stored, two candidates can push, and a UI exists
- **THEN** the result is "ask" with both candidates as options

#### Scenario: Several writers without UI
- **WHEN** no environment token is set, nothing is stored, two candidates can push, and no UI exists
- **THEN** the result refuses writes and names both candidates and the `/livespec account <name>` command

#### Scenario: No writer
- **WHEN** no environment token is set, no candidate can push, and the stored account is missing or not `unknown`
- **THEN** the result refuses writes and says how to log in for that forge

#### Scenario: Stale stored account
- **WHEN** no environment token is set, the stored account can no longer push, and exactly one other candidate can
- **THEN** the other candidate is stored and used

#### Scenario: Stored account disappeared
- **WHEN** no environment token is set, the stored account is no longer among the candidates, and exactly one other candidate can push
- **THEN** that candidate is stored and used

#### Scenario: Remote changed
- **WHEN** no environment token is set and `livespec.accountRemote` differs from the current origin
- **THEN** the stored account is ignored and the selection runs again

#### Scenario: Offline with stored account
- **WHEN** no environment token is set, the stored account matches the remote, is still a candidate, its own check is `unknown`, and no candidate can push
- **THEN** the stored account is used and marked unverified

#### Scenario: Unknown stored account loses to a writer
- **WHEN** no environment token is set, the stored account's check is `unknown`, and exactly one other candidate can push
- **THEN** the other candidate is stored and used

#### Scenario: Denied stored account not revived
- **WHEN** no environment token is set, the stored account is `false`, another candidate is `unknown`, and none is `true`
- **THEN** writes are refused and the stored account is not used

### Requirement: Selection at session start
In an initialized project, livespec SHALL run the account selection during `session_start`, after the forge kind and host are known and before any forge write of that session, including the first snapshot refresh. When the selection stores an account it MUST say so in one notice naming the account and why. In an uninitialized project no selection runs and nothing is written.

#### Scenario: First session
- **WHEN** a session starts in an initialized clone with no environment token, no stored account, and only `ttdua` can push
- **THEN** `ttdua` is stored before the first refresh and a notice says "livespec uses `ttdua` for this repository (chosen automatically)"

#### Scenario: Later session
- **WHEN** a later session starts with no environment token, `ttdua` stored for the same origin, and `ttdua` still able to push
- **THEN** nothing is written to the git config and no notice is shown

#### Scenario: Uninitialized project
- **WHEN** a session starts in a project without `.pi/livespec/config.yaml`
- **THEN** no candidate is checked and the git config is unchanged

### Requirement: Ask once
When the selection asks, livespec SHALL show the writable candidates through the interactive UI once, store the chosen candidate, and not ask again while it stays valid. A cancelled question MUST refuse writes with the same explanation as the no-UI case.

#### Scenario: Answer stored
- **WHEN** the user picks `gitea.example.org` from the question
- **THEN** it is stored and the next session starts without asking

#### Scenario: Cancelled
- **WHEN** the user cancels the question
- **THEN** writes are refused and the card names `/livespec account <name>`

### Requirement: Identity confirmation
After the adapter is built, livespec SHALL confirm the identity: for a chosen candidate, `whoami()` must equal the candidate's user; for an environment token, a successful `whoami()` is the identity.

#### Scenario: Confirmed candidate
- **WHEN** `ttdua` was chosen and `whoami()` returns `ttdua`
- **THEN** writes are allowed

### Requirement: Writes blocked without a confirmed identity
When the identity differs, `whoami()` fails, or the selection refused, every forge mutation livespec makes MUST be refused, including automatic writes such as the phase advance, while reads keep working. The block MUST stay until a later selection or a successful `/livespec account <name>` confirms an identity; a successful read alone MUST NOT lift it.

#### Scenario: Mismatch blocks writes
- **WHEN** the selected candidate's user is `ttdua` but `whoami()` returns `naicoi92`
- **THEN** `change_new` refuses with a message naming both logins

#### Scenario: Refusal blocks writes
- **WHEN** the selection refused because several accounts can push and no UI exists
- **THEN** `spec_write` refuses with that reason and `spec_status` still answers

#### Scenario: Automatic advance blocked
- **WHEN** writes are blocked and a change in `build` has every unit done
- **THEN** no label change is sent to the forge and the card shows the block

#### Scenario: Identity unconfirmed
- **WHEN** `whoami()` fails after the account is chosen
- **THEN** writes are refused until the identity is confirmed

### Requirement: Account command
`/livespec account` SHALL print the host, the account in use, its source (`environment`, `stored`, `automatic`, `asked`), the stored remote, and every candidate with its access and the reason it was not chosen. `/livespec account <name>` SHALL check that candidate's access, store it when it can push, rebuild the session's forge connection with it, and print the result.

#### Scenario: Show
- **WHEN** the user runs `/livespec account` after `ttdua` was chosen automatically
- **THEN** the output shows `github.com`, `ttdua`, source `automatic`, and `naicoi92` with access `false`

#### Scenario: Switch
- **WHEN** no environment token is set and the user runs `/livespec account gitea.example.org`, which can push
- **THEN** it is stored, the session's forge now uses it, and later writes in the same session use it

### Requirement: Account switch refusals
`/livespec account <name>` MUST refuse, storing nothing, a candidate that cannot push or does not exist, and any switch while the environment token of the forge in use is set, explaining that the environment variable decides.

#### Scenario: Switch refused without access
- **WHEN** the user runs `/livespec account naicoi92` and that account cannot push
- **THEN** nothing is stored and the output says why

#### Scenario: Unknown name
- **WHEN** the user runs `/livespec account nobody`
- **THEN** nothing is stored and the output lists the candidates

#### Scenario: Environment override
- **WHEN** `GH_TOKEN` is set for a `github.com` remote and the user runs `/livespec account ttdua`
- **THEN** nothing is stored and the output says `GH_TOKEN` decides the account

### Requirement: Doctor and card report
A registered doctor check SHALL report the account in use and its source, every candidate left out with the reason, a warning when the account is unverified, and an error with the exact `/livespec account` command when writes are blocked; it MUST NOT write any setting and MUST NOT run a selection that stores. A registered phase-card section SHALL show one line when writes are blocked by the account, or on the first card after an automatic or asked choice, and nothing otherwise.

#### Scenario: Doctor ok
- **WHEN** the account is stored and verified
- **THEN** doctor reports `ok` with the account, source and the candidates left out, and doctor leaves `.git/config` unchanged

#### Scenario: Doctor unverified
- **WHEN** the stored account is used unverified because the forge was unreachable
- **THEN** doctor reports `warn` saying the account is unverified

#### Scenario: Doctor blocked
- **WHEN** writes are blocked because several accounts can push
- **THEN** doctor reports `error` with both names and the `/livespec account <name>` command

#### Scenario: Card quiet in steady state
- **WHEN** the stored account is reused and verified
- **THEN** the phase card has no account line

#### Scenario: Card after automatic choice
- **WHEN** the account was just chosen automatically
- **THEN** the first card names the account and says it was chosen automatically, and later cards have no account line

#### Scenario: Card after asked choice
- **WHEN** the account was just chosen through the question
- **THEN** the first card names the account and says the user chose it

#### Scenario: Card when blocked
- **WHEN** writes are blocked by the account
- **THEN** every card shows the reason and the `/livespec account <name>` command

### Requirement: Secret handling
Tokens SHALL be passed to subprocesses only through the environment of that call, never as arguments, and MUST NOT appear in any notice, error, command output, doctor result, card, cache file, log or tool details, including on failure. Forge-derived text in account messages shown to the model (logins reported by the forge, forge error text) MUST be wrapped as untrusted.

#### Scenario: No token in arguments
- **WHEN** candidates are checked and the adapter makes calls
- **THEN** no subprocess argument contains a token

#### Scenario: No token in output on failure
- **WHEN** a candidate check fails with a forge error
- **THEN** the token does not occur in the error, the doctor output or the card

#### Scenario: Untrusted forge text
- **WHEN** the forge reports a login containing `</untrusted>` in a mismatch
- **THEN** the card shows it escaped inside `<untrusted>`
