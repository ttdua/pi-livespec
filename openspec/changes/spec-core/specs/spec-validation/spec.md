## ADDED Requirements

### Requirement: Validation result
Every validator SHALL return a list of results `{ code, severity, file or section, line, message }` where severity is `error` or `warning`.

#### Scenario: Result shape
- **WHEN** a validator finds a problem
- **THEN** the result has a stable `code`, a `severity`, a location, a line (when known) and a message

### Requirement: Living spec checks
The validator SHALL report an error when a requirement lacks SHALL or MUST, a requirement has no scenario, a scenario lacks WHEN or THEN, requirement names repeat within a capability, or a `paths` glob is invalid.

#### Scenario: Missing normative word
- **WHEN** a requirement text has neither SHALL nor MUST
- **THEN** an error is reported at that requirement

#### Scenario: Requirement without scenario
- **WHEN** a requirement has no scenario
- **THEN** an error is reported

#### Scenario: Scenario missing THEN
- **WHEN** a scenario has WHEN but no THEN
- **THEN** an error is reported

#### Scenario: Duplicate requirement name
- **WHEN** two requirements in one capability share a name
- **THEN** an error is reported

#### Scenario: Invalid paths glob
- **WHEN** front matter `paths` contains `src/{a,b`
- **THEN** an error is reported

#### Scenario: Valid spec
- **WHEN** the example `rate-limit` spec is validated
- **THEN** no results are returned

### Requirement: Glossary checks
The validator SHALL report an error when glossary terms are not sorted A to Z or when a term appears twice.

#### Scenario: Unsorted terms
- **WHEN** `Unit` is listed before `Change`
- **THEN** an error is reported

#### Scenario: Duplicate term
- **WHEN** a term appears twice
- **THEN** an error is reported

### Requirement: Decision checks
The validator SHALL report an error when decision numbers repeat, when a `superseded` decision has no `superseded_by`, or when `superseded_by` names a decision that does not exist. Given a git diff, it SHALL report an error for a deleted decision file.

#### Scenario: Duplicate number
- **WHEN** two files start with `0003-`
- **THEN** an error is reported

#### Scenario: Superseded without pointer
- **WHEN** a decision has `status: superseded` and no `superseded_by`
- **THEN** an error is reported

#### Scenario: Pointer to missing decision
- **WHEN** `superseded_by: 9` and no decision 0009 exists
- **THEN** an error is reported

#### Scenario: Decision deleted in diff
- **WHEN** the diff deletes `specs/decisions/0001-x.md`
- **THEN** an error says a decision is never deleted, only superseded

### Requirement: Unit format check
The `units-format` check SHALL report an error when a required unit field is missing or malformed, unit ids repeat, or a `Depends` entry names a missing unit. `Difficulty` MUST be `low`, `medium` or `high`; `Verify` MUST be exactly one backticked command; `Done means` items MUST each carry a `[label]`.

#### Scenario: Missing field
- **WHEN** a unit has no `Files` field
- **THEN** a `units-format` error is reported

#### Scenario: Bad difficulty
- **WHEN** `Difficulty: hard`
- **THEN** an error is reported

#### Scenario: Two Verify commands
- **WHEN** `Verify` holds two backticked commands
- **THEN** an error is reported

#### Scenario: Duplicate unit id
- **WHEN** two units are both `U3`
- **THEN** an error is reported

#### Scenario: Depends on missing unit
- **WHEN** a unit has `Depends: U9` and no U9 exists
- **THEN** an error is reported

#### Scenario: Example units valid
- **WHEN** the example body's unit U3 (with U1 added) is checked
- **THEN** no error is reported

### Requirement: Done-maps-scenarios check
The `done-maps-scenarios` check SHALL report an error for a `Done means` label with no scenario of the same label, and for a scenario label absent from `Done means`.

#### Scenario: Done item without scenario
- **WHEN** `Done means` has `[cap]` and `Scenarios` has none
- **THEN** an error is reported

#### Scenario: Scenario without done item
- **WHEN** `Scenarios` has `[x]` and `Done means` has none
- **THEN** an error is reported

#### Scenario: Labels match
- **WHEN** both use `[cap]`
- **THEN** no error is reported

### Requirement: Capabilities match diff
The `capabilities-match-diff` check, given the change issue and the text of `git diff <Base>..HEAD -- specs/`, SHALL report an error for a capability declared but not touched, for a capability touched but not declared, and for a capability declared `new` whose directory the diff does not create. Without `Base` it SHALL report that the change is not started.

#### Scenario: Declared but untouched
- **WHEN** `modified [rate-limit]` is declared and the diff touches nothing under `specs/rate-limit/`
- **THEN** an error is reported

#### Scenario: Touched but undeclared
- **WHEN** the diff edits `specs/other/spec.md` and `other` is not declared
- **THEN** an error is reported

#### Scenario: New must be created
- **WHEN** `new [cache]` is declared and the diff only modifies an existing `specs/cache/spec.md`
- **THEN** an error is reported

#### Scenario: Consistent diff
- **WHEN** declarations equal the touched capabilities and new ones are created
- **THEN** no error is reported

#### Scenario: Not started
- **WHEN** the issue has no `Base` line
- **THEN** the result says the change is not started, with no error

### Requirement: Validate command and tool
`/livespec validate` and the `spec_validate` tool SHALL run every applicable check over the repository's `specs/` folder, list the results, and make the command exit non-zero when any result is an error.

#### Scenario: Clean repository
- **WHEN** `specs/` contains only valid files
- **THEN** the command reports no results and exits zero

#### Scenario: Error present
- **WHEN** a spec has a requirement without a scenario
- **THEN** the output lists that error and the exit status is non-zero

#### Scenario: Tool returns results
- **WHEN** the `spec_validate` tool is called
- **THEN** it returns the same result list as the command

#### Scenario: Missing specs folder
- **WHEN** the repository has no `specs/` folder
- **THEN** the command reports that there is nothing to validate and exits zero
