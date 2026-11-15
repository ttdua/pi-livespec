# gitea-adapter Specification

## Purpose

Defines the Gitea adapter: REST transport with a token, version checks through `content_version` when the server sends it and a re-read check otherwise, and coverage of the `Forge` operations.

## Requirements

### Requirement: Gitea transport and auth
The Gitea adapter SHALL call `/api/v1` with Node's built-in `fetch` and a token, and MUST NOT run `tea`. The token MUST come from `GITEA_TOKEN`; otherwise from the `tea` config login whose name the adapter was given, which MUST also have a URL host equal to the server's; otherwise from the single `tea` login whose URL host matches the server. When several `tea` logins match the host and no login name was given, the adapter MUST throw `ForgeError` with code `auth` naming those logins, and MUST NOT pick one by file order.

#### Scenario: Token from environment
- **WHEN** `GITEA_TOKEN` is set
- **THEN** requests carry it in the authorization header

#### Scenario: Token from tea config
- **WHEN** `GITEA_TOKEN` is unset, no login name is given, and the `tea` config has exactly one login for the host
- **THEN** that login's token is used and no process is spawned

#### Scenario: Named login
- **WHEN** `GITEA_TOKEN` is unset, the `tea` config has logins `gitea.example.org` and `gitea-admin` for the host, and the adapter is given the login name `gitea.example.org`
- **THEN** requests carry the token of `gitea.example.org`

#### Scenario: Ambiguous logins
- **WHEN** `GITEA_TOKEN` is unset, two `tea` logins match the host, and no login name is given
- **THEN** the adapter throws `ForgeError` with code `auth` whose message names both logins, and no request is sent

#### Scenario: Named login missing
- **WHEN** `GITEA_TOKEN` is unset and the given login name is not in the `tea` config
- **THEN** the adapter throws `ForgeError` with code `auth` naming the missing login

#### Scenario: Named login for another host
- **WHEN** `GITEA_TOKEN` is unset and the given login exists but its URL host is not the server's host
- **THEN** the adapter throws `ForgeError` with code `auth` before any request is sent

#### Scenario: No token
- **WHEN** no token is found
- **THEN** the adapter throws `ForgeError` with code `auth`

### Requirement: Gitea version from content_version when present
When the issue or pull request response carries `content_version`, the version SHALL be built from it, the edit MUST send it, and an HTTP 409 MUST be returned as `conflict`.

#### Scenario: Stale content_version
- **WHEN** the server answers 409 to an edit
- **THEN** the result is `conflict` and the body is unchanged

#### Scenario: Current content_version
- **WHEN** the edit is sent with the version just read
- **THEN** the result is `written` with `check: "strict"`

### Requirement: Fallback when content_version is absent
When the response has no `content_version`, the adapter SHALL use the same re-read and compare check as GitHub and return `check: "best-effort"`. It MUST NOT refuse the write because of the server version.

#### Scenario: Older server
- **WHEN** the response has no `content_version` and the body is unchanged
- **THEN** the write succeeds with `check: "best-effort"`

#### Scenario: Older server, changed body
- **WHEN** the response has no `content_version` and the body changed since the read
- **THEN** the result is `conflict`

### Requirement: Gitea operation coverage
The Gitea adapter SHALL implement every `Forge` operation. Comment edits are last-write-wins, and checks come from commit statuses.

#### Scenario: Comments
- **WHEN** a comment is created, listed and edited
- **THEN** each call returns the expected id, author and body

#### Scenario: Labels
- **WHEN** a label is missing
- **THEN** it is created through `POST /labels` before being applied

#### Scenario: Checks from statuses
- **WHEN** `getChecks(ref)` is called
- **THEN** it returns the overall state and each status as a check
