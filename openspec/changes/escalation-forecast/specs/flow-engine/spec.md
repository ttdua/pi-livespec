## MODIFIED Requirements

### Requirement: Named checks over LS-02 validators
The engine SHALL register the named checks `spec-format` (living spec validation of the capabilities the change declares), `units-format`, `done-maps-scenarios` and `capabilities-match-diff`, each returning the LS-02 `Result` list. The engine SHALL run only the checks the active phase lists, and later specs MUST be able to register more checks.

A check MAY be registered as gate-only. A gate-only check SHALL run only when its gate is requested. On every other run of the checks, the engine SHALL report the check's last results that are still valid for the current state, or no result, and SHALL report which of its gate-only checks have no such results. A gate-only check without a validity key SHALL always be among them.

#### Scenario: Units check in plan
- **WHEN** the change is in `plan` and unit U2 lacks `Verify`
- **THEN** the outstanding checks contain a `units-format` error for U2

#### Scenario: Only active phase checks
- **WHEN** the change is in `shape`
- **THEN** no check is run

#### Scenario: Gate-only check skipped on refresh
- **WHEN** a test registers gate-only check `slow` for `plan`, and the change state is refreshed twice without a gate request
- **THEN** `slow` does not run and reports no result

#### Scenario: Capabilities mismatch
- **WHEN** the change declares `modified [rate-limit]` and the diff from `Base` touches only `specs/auth/`
- **THEN** `capabilities-match-diff` reports both mismatches

#### Scenario: Gate-only check without a valid result is named
- **WHEN** a test registers keyed gate-only check `slow` for `plan`, and the change state is refreshed before any gate request, then a gate request runs `slow` with no result, then the state is refreshed again
- **THEN** the first refresh names `slow` as without a valid result, and the second reports no result for `slow` and does not name it

#### Scenario: Changed key names the check again
- **WHEN** keyed gate-only check `slow` ran at a gate request under key K1, and the state's key is now K2
- **THEN** a refresh reports no result for `slow` and names it as without a valid result
