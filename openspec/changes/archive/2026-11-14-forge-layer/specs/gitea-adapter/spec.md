## ADDED Requirements

### Requirement: Gitea transport and auth
The Gitea adapter SHALL call `/api/v1` with Node's built-in `fetch` and a token. The token MUST come from `GITEA_TOKEN` or be read from the `tea` config file, and the adapter MUST NOT run `tea`.

#### Scenario: Token from environment
- **WHEN** `GITEA_TOKEN` is set
- **THEN** requests carry it in the authorization header

#### Scenario: Token from tea config
- **WHEN** `GITEA_TOKEN` is unset and the `tea` config has a login for the host
- **THEN** that login's token is used and no process is spawned

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
