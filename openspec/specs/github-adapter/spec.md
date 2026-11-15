# github-adapter Specification

## Purpose

Defines the GitHub adapter: transport through the `gh` CLI, authentication, the re-read check that keeps body writes fail-closed, and coverage of the `Forge` operations.

## Requirements

### Requirement: GitHub transport and auth
The GitHub adapter SHALL call the forge only through `gh api` with JSON output, and its authentication check MUST use `gh auth status`. When the adapter is given an account token, every `gh` call it makes (`api` and `auth status`) MUST run with that token in the environment of that call only, in the variable `gh` reads for the host (`GH_TOKEN` for `github.com` and `*.ghe.com`, `GH_ENTERPRISE_TOKEN` for a GitHub Enterprise Server host), so the account that is active machine-wide in `gh` does not decide its identity. The adapter MUST NOT run `gh auth switch` and MUST NOT pass a token on the command line.

#### Scenario: Not logged in
- **WHEN** `gh auth status` fails
- **THEN** the adapter throws `ForgeError` with code `auth`

#### Scenario: Identity
- **WHEN** `whoami()` is called
- **THEN** it returns the login reported by `gh api user`

#### Scenario: Account token used
- **WHEN** the adapter is built for `github.com` with the token of account `ttdua` while `naicoi92` is the active `gh` account
- **THEN** every `gh` call it makes carries `GH_TOKEN` equal to that token and `whoami()` returns `ttdua`

#### Scenario: Enterprise host token
- **WHEN** the adapter is built for the Enterprise host `ghe.example.org` with a token
- **THEN** every `gh` call carries `GH_ENTERPRISE_TOKEN` equal to that token and `--hostname ghe.example.org`

#### Scenario: Token not in arguments
- **WHEN** the adapter is built with a token and makes any call
- **THEN** no `gh` argument contains the token

#### Scenario: No token given
- **WHEN** the adapter is built without a token
- **THEN** no `GH_TOKEN` is added and the calls behave as before

### Requirement: GitHub body version and re-read check
The version of a GitHub issue or pull request SHALL combine `updated_at` and a hash of the body. Before a body write the adapter MUST read the item again and compare; on mismatch it MUST NOT send the PATCH.

#### Scenario: Changed since read
- **WHEN** the body was edited on GitHub after the caller read it
- **THEN** `updateIssueBody` returns `conflict` and no PATCH is issued

#### Scenario: Unchanged
- **WHEN** nothing changed since the read
- **THEN** the PATCH is issued and the result is `written` with `check: "best-effort"`, because GitHub has no server-side conditional write and the re-read compare is best-effort

### Requirement: GitHub operation coverage
The GitHub adapter SHALL implement every `Forge` operation, including pull requests, reviews, review comments and check summaries, through `gh api` endpoints.

#### Scenario: Pull request flow
- **WHEN** a pull request is created, listed by head, read and updated
- **THEN** each call returns the expected state, merged flag and branches

#### Scenario: Checks summary
- **WHEN** `getChecks(ref)` is called
- **THEN** it returns an overall state and one entry per check with name, state and details URL
