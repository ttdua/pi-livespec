## MODIFIED Requirements

### Requirement: Read-only mode
When the forge cannot be reached, reads SHALL return the cached issue marked `stale: true`, and every forge write MUST be refused with a `ForgeError` of code `readonly` and a clear message. Ledger appends are not forge writes and MUST NOT be refused by read-only mode (see `ledger-store`).

#### Scenario: Unreachable read
- **WHEN** the forge is unreachable and the issue is cached
- **THEN** `getIssue` returns the cached issue with `stale: true`

#### Scenario: Unreachable write
- **WHEN** the forge is unreachable and a write is attempted
- **THEN** a `ForgeError` with code `readonly` is thrown and nothing is sent

#### Scenario: Not cached
- **WHEN** the forge is unreachable and the issue is not cached
- **THEN** a `ForgeError` with code `unreachable` is thrown

#### Scenario: Ledger append in read-only mode
- **WHEN** the forge is in read-only mode and a ledger entry is appended
- **THEN** the entry is written to the local ledger and no `ForgeError` is thrown
