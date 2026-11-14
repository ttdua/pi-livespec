## ADDED Requirements

### Requirement: Issue cache
Reads SHALL write the raw issue, its `version` and the fetch time to `<cacheRoot>/<host>/<owner>/<repo>/<issue>.json`, where `cacheRoot` defaults to `~/.pi/agent/livespec/cache`. Deleting the cache MUST lose no durable state.

#### Scenario: Read writes through
- **WHEN** an issue is read successfully
- **THEN** the cache file contains the issue, its version and the fetch time

#### Scenario: Cache deleted
- **WHEN** the cache directory is removed
- **THEN** the next read refetches from the forge and succeeds

### Requirement: Read-only mode
When the forge cannot be reached, reads SHALL return the cached issue marked `stale: true`, and every write MUST be refused with a `ForgeError` of code `readonly` and a clear message.

#### Scenario: Unreachable read
- **WHEN** the forge is unreachable and the issue is cached
- **THEN** `getIssue` returns the cached issue with `stale: true`

#### Scenario: Unreachable write
- **WHEN** the forge is unreachable and a write is attempted
- **THEN** a `ForgeError` with code `readonly` is thrown and nothing is sent

#### Scenario: Not cached
- **WHEN** the forge is unreachable and the issue is not cached
- **THEN** a `ForgeError` with code `unreachable` is thrown

### Requirement: Read-only mode only for unreachability
Read-only mode SHALL start only after a transport-level failure. HTTP error responses MUST NOT start it, and a later successful read MUST leave it.

#### Scenario: HTTP error
- **WHEN** the forge answers 404 to a read
- **THEN** a `ForgeError` with code `http` is thrown and writes remain allowed

#### Scenario: Recovery
- **WHEN** a read succeeds after an unreachable failure
- **THEN** writes are allowed again
