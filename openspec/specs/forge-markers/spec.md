# forge-markers Specification

## Purpose

Defines the machine-readable comment markers that tools write on issues, the rule that only the current account's marked comments count as state, own-marker comment edits, and the label conventions.

## Requirements

### Requirement: Comment marker format
Every comment a tool writes SHALL start with the line `<!-- livespec:{kind}:{id} -->` and carry one fenced `yaml` block with the data.

#### Scenario: Written comment shape
- **WHEN** a marked comment is created for kind `receipt` and id `u1`
- **THEN** its body starts with `<!-- livespec:receipt:u1 -->` and contains a fenced yaml block

#### Scenario: Round trip
- **WHEN** data is written with a marker and read back
- **THEN** the parsed data equals the original

### Requirement: Core kinds and registration
The core marker kinds SHALL be `receipt`, `gate`, `amendment`, `counter`, `decision`, `question`, `stale`, `incomplete`, `finding-summary` and `stuck`. `registerKind(name)` MUST add a kind, and writing an unregistered kind MUST fail.

#### Scenario: Registered kind
- **WHEN** `registerKind("review-lane")` is called and a comment of that kind is written
- **THEN** the write succeeds

#### Scenario: Unknown kind
- **WHEN** a comment of an unregistered kind is written
- **THEN** the write throws before reaching the forge

### Requirement: Only own marked comments count
`readMarkedComments(issue)` SHALL return only comments that have a marker and were written by the current `whoami()` login. A marked comment from another account MUST be ignored and reported as a warning, with no exceptions.

#### Scenario: Foreign marked comment
- **WHEN** another account posts a comment with a valid marker
- **THEN** it is not returned and a warning names its author

#### Scenario: Own marked comment
- **WHEN** the current account posts a marked comment
- **THEN** it is returned with its parsed data

#### Scenario: Plain comment
- **WHEN** a comment has no marker
- **THEN** it is not returned and no warning is raised

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
