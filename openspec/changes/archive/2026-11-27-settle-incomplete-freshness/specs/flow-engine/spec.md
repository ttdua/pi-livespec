## MODIFIED Requirements

### Requirement: Next step
`nextStep(pack, changeState)` SHALL be a pure function. It returns the current phase, the required and optional skills, the redirects, outstanding check results, open blocking questions, counters with their caps, active units, units waiting on `Depends`, started units, blocked units with their reason, the items of the latest `incomplete` comment reconciled with the current state, an optional phase to advance to, and exactly one sentence saying what to do next. Reconciling SHALL drop an item of the form `<unit> is started` whose unit is not started in the change state, and SHALL keep every other item as recorded.

#### Scenario: Pure
- **WHEN** `nextStep` is called twice with equal inputs
- **THEN** both results are deeply equal and no I/O is performed

#### Scenario: Finished unit dropped from incomplete items
- **WHEN** the latest `incomplete` comment lists `U2 is started`, `U3 is started` and `uncommitted changes in the working tree`, U2 has a receipt and is not started, and U3 is still started
- **THEN** the returned incomplete items are `U3 is started` and `uncommitted changes in the working tree`, in that order

#### Scenario: Still-started unit kept
- **WHEN** the latest `incomplete` comment lists `U2 is started` and U2 is still started
- **THEN** the returned incomplete items contain `U2 is started`

#### Scenario: Other items kept as recorded
- **WHEN** the latest `incomplete` comment lists `review pending for U2` and no unit is started
- **THEN** the returned incomplete items are `review pending for U2`
