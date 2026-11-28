# forge-markers Specification

## Purpose

Defines the machine-readable comment markers that tools write on issues, the rule that only the current account's marked comments count as state, own-marker comment edits, and the label conventions.

## Requirements

### Requirement: Comment marker format
Every comment a tool writes SHALL start with the line `<!-- livespec:{kind}:{id} -->` and carry one fenced `yaml` block with the data.

#### Scenario: Written comment shape
- **WHEN** a marked comment is created for kind `stale` and id `u1`
- **THEN** its body starts with `<!-- livespec:stale:u1 -->` and contains a fenced yaml block

#### Scenario: Round trip
- **WHEN** data is written with a marker and read back
- **THEN** the parsed data equals the original

### Requirement: Core kinds and registration
The core marker kinds SHALL be `gate`, `amendment`, `question`, `stale`, `incomplete` and `stuck`. `registerKind(name)` MUST add a kind, and writing an unregistered kind MUST fail. The ledger kinds `decision`, `dispatch`, `finding-summary`, `receipt`, `unit-start` and `counter` (see `ledger-store`) MUST NOT be marker kinds: `registerKind` MUST refuse them and writing a marked comment of one of them MUST fail.

#### Scenario: Registered kind
- **WHEN** `registerKind("review-lane")` is called and a comment of that kind is written
- **THEN** the write succeeds

#### Scenario: Unknown kind
- **WHEN** a comment of an unregistered kind is written
- **THEN** the write throws before reaching the forge

#### Scenario: Ledger kind refused
- **WHEN** a marked comment of kind `receipt` is written
- **THEN** the write throws before reaching the forge

### Requirement: Only own marked comments count
`readMarkedComments(issue)` SHALL return only comments that have a marker and were written by the current `whoami()` login. A marked comment from another account MUST be ignored and reported as a warning, with no exceptions. An own marked comment of a ledger kind MUST be ignored; the read SHALL report one warning per such kind, saying that its records live in the ledger.

#### Scenario: Foreign marked comment
- **WHEN** another account posts a comment with a valid marker
- **THEN** it is not returned and a warning names its author

#### Scenario: Own marked comment
- **WHEN** the current account posts a marked comment
- **THEN** it is returned with its parsed data

#### Scenario: Plain comment
- **WHEN** a comment has no marker
- **THEN** it is not returned and no warning is raised

#### Scenario: Old receipt comment
- **WHEN** the issue holds two own `receipt` comments written by an earlier version
- **THEN** neither is returned, and one warning says `receipt` records live in the ledger

### Requirement: Own-marker comment edits
The plugin SHALL edit a comment only when it carries a marker and was written by the current account. `updateComment` of every adapter MUST enforce this by re-reading the comment before writing; stale versions stay last-write-wins.

#### Scenario: Edit a foreign comment
- **WHEN** an edit targets a comment written by another account
- **THEN** it is refused with `ForgeError` and the comment is unchanged

#### Scenario: Edit an unmarked own comment
- **WHEN** an edit targets a comment of the current account that has no marker
- **THEN** it is refused with `ForgeError` and the comment is unchanged

### Requirement: Labels
The label constants SHALL be `livespec`, `livespec:phase/<phase>`, `livespec:initiative` and `livespec:parked`. The adapter MUST create a missing label the first time it is needed.

#### Scenario: Missing label is created
- **WHEN** `addLabels` is called with a label the repository does not have
- **THEN** the label is created and then applied

#### Scenario: Existing label
- **WHEN** the label already exists
- **THEN** it is applied without creating it again
