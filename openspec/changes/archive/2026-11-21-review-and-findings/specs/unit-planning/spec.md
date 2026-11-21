## ADDED Requirements

### Requirement: Simplify unit kind
`unit_amend` MUST refuse, sending no request, a new or replacement unit whose title is `simplify` (ignoring case) and whose `Kind` is not `refactor`, saying a simplify unit must be a refactor.

#### Scenario: Simplify as a feature
- **WHEN** `unit_amend --add` adds a unit titled `simplify` with no `Kind` line
- **THEN** the tool refuses, says it must be `Kind: refactor`, and sends no request

#### Scenario: Simplify as a refactor
- **WHEN** `unit_amend --add` adds a unit titled `simplify` with `Kind: refactor` and a valid `Verify`
- **THEN** the light gate request is sent
