## ADDED Requirements

### Requirement: GitHub transport and auth
The GitHub adapter SHALL call the forge only through `gh api` with JSON output, and its authentication check MUST use `gh auth status`.

#### Scenario: Not logged in
- **WHEN** `gh auth status` fails
- **THEN** the adapter throws `ForgeError` with code `auth`

#### Scenario: Identity
- **WHEN** `whoami()` is called
- **THEN** it returns the login reported by `gh api user`

### Requirement: GitHub body version and re-read check
The version of a GitHub issue or pull request SHALL combine `updated_at` and a hash of the body. Before a body write the adapter MUST read the item again and compare; on mismatch it MUST NOT send the PATCH.

#### Scenario: Changed since read
- **WHEN** the body was edited on GitHub after the caller read it
- **THEN** `updateIssueBody` returns `conflict` and no PATCH is issued

#### Scenario: Unchanged
- **WHEN** nothing changed since the read
- **THEN** the PATCH is issued and the result is `written` with `check: "strict"`

### Requirement: GitHub operation coverage
The GitHub adapter SHALL implement every `Forge` operation, including pull requests, reviews, review comments and check summaries, through `gh api` endpoints.

#### Scenario: Pull request flow
- **WHEN** a pull request is created, listed by head, read and updated
- **THEN** each call returns the expected state, merged flag and branches

#### Scenario: Checks summary
- **WHEN** `getChecks(ref)` is called
- **THEN** it returns an overall state and one entry per check with name, state and details URL
