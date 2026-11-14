# forge-interface Specification

## Purpose

Defines the `Forge` interface that hides GitHub and Gitea behind one contract: the opaque `version` on every issue, pull request and comment, fail-closed body writes, error codes, forge detection, and the shared contract suite that both adapters must pass.

## Requirements

### Requirement: Forge interface
The package SHALL export a `Forge` interface with `kind` (`github` or `gitea`) and the operations for identity, issues, labels, comments, pull requests, reviews and checks listed in the plan contracts. Every issue, pull request and comment it returns MUST carry an opaque `version`.

#### Scenario: Both adapters implement the interface
- **WHEN** the contract suite runs
- **THEN** the GitHub adapter and the Gitea adapter each pass every contract test

#### Scenario: Version is returned on read
- **WHEN** `getIssue(n)` returns an issue
- **THEN** the issue has a non-empty `version`

### Requirement: Fail-closed body writes
`updateIssueBody` and `updatePullRequest` (when a body is given) SHALL take the `version` the caller read. If the forge copy changed since that version, the adapter MUST NOT write and MUST return a `conflict` result that names what changed.

#### Scenario: Stale issue body edit
- **WHEN** the issue body is changed on the forge after the caller read it and the caller calls `updateIssueBody` with the old version
- **THEN** the result is `conflict`, the forge body is unchanged, and the result lists `body` as changed

#### Scenario: Current version edit
- **WHEN** the caller passes the version it just read
- **THEN** the result is `written` and the returned `item` has a version different from the one passed in

### Requirement: Failures are thrown, not blocked by server version
Transport, authentication and HTTP failures SHALL throw `ForgeError` with a `code` of `unreachable`, `auth`, `http`, `readonly` or `unsupported`. An adapter MUST NOT refuse an operation only because of the server version; only a failed call blocks.

#### Scenario: Auth failure
- **WHEN** the forge rejects the credentials
- **THEN** a `ForgeError` with code `auth` is thrown and its message names the operation

#### Scenario: No version gate
- **WHEN** an operation is supported by the server's response
- **THEN** the adapter performs it without checking a server version number

### Requirement: Forge detection
`detectForge(repoRoot)` SHALL choose an adapter from the `origin` remote and the optional project config: `github.com` or a configured GitHub Enterprise host selects GitHub; config `forge: gitea` with a host, or a successful `/api/v1/version` probe of the `origin` host, selects Gitea.

#### Scenario: GitHub remote
- **WHEN** `origin` points at `github.com`
- **THEN** a GitHub adapter is returned

#### Scenario: Gitea by config
- **WHEN** config sets `forge: gitea` and a host
- **THEN** a Gitea adapter for that host is returned without probing

#### Scenario: Gitea by probe
- **WHEN** the `origin` host answers `/api/v1/version`
- **THEN** a Gitea adapter is returned

#### Scenario: Unknown host
- **WHEN** the host is neither GitHub nor configured nor answers the probe
- **THEN** detection throws `ForgeError` with code `unsupported`

### Requirement: Shared contract suite
One contract test suite SHALL run against both adapters, using a fake `gh` executable and a loopback fake Gitea server, and MUST need no network beyond loopback and no secrets.

#### Scenario: Offline run
- **WHEN** the tests run without network access
- **THEN** the contract suite passes
