## ADDED Requirements

### Requirement: Change issue body parsing
The system SHALL parse a change issue body into its ownership lines (`Base`, `Branch`, `Initiative`, `Depends`, `Capabilities`, `Product impact`, `PR`), `## Proposal`, `## Design`, `## Questions`, `## Units` and `## Durable docs` sections, and SHALL serialize it back byte for byte, preserving unknown sections.

#### Scenario: Example body round trip
- **WHEN** the example change body from the LS-02 brief is parsed and serialized
- **THEN** the output equals the input byte for byte

#### Scenario: Optional ownership lines
- **WHEN** a body has no `Initiative`, `Depends` or `PR` line
- **THEN** parsing succeeds and those fields are absent

#### Scenario: Capabilities line
- **WHEN** the line is `Capabilities: new [], modified [rate-limit]`
- **THEN** `new` is empty and `modified` is `[rate-limit]`

#### Scenario: Unknown section kept
- **WHEN** a body contains a `## Notes` section
- **THEN** serializing keeps it unchanged

### Requirement: Questions parsing
The system SHALL parse each `## Questions` item as an id, a kind (`blocking` or `non-blocking`), the text, the checked state and an optional answer after ` — Answer: `.

#### Scenario: Open and answered questions
- **WHEN** the section has `- [ ] Q1 (blocking): ...` and `- [x] Q2 (non-blocking): ... — Answer: yes`
- **THEN** Q1 is open and blocking, Q2 is checked, non-blocking, with answer `yes`

### Requirement: Unit parsing
The system SHALL parse each `### U<n> — <title>` block under `## Units` into the fields `Covers`, `Difficulty`, `Tags`, `Files`, `Done means`, `Scenarios`, `Depends`, `Verify`, optional `Kind`, and the status line.

#### Scenario: Example unit fields
- **WHEN** the example unit U3 is parsed
- **THEN** Covers is `rate-limit/Requirement: Per-IP cap`, Difficulty `medium`, Tags `[security, api]`, one Done means item labeled `cap`, Depends `U1`, and status pending

#### Scenario: Depends dash
- **WHEN** a unit has `Depends: —`
- **THEN** its dependency list is empty

#### Scenario: Kind refactor
- **WHEN** a unit has `Kind: refactor`
- **THEN** the parsed unit has kind `refactor`

### Requirement: Initiative body parsing
The system SHALL parse an initiative body into `Goal`, `Capabilities` and the `## Changes` list (checked state, issue number, change name, `Depends`), and serialize it back byte for byte.

#### Scenario: Example initiative round trip
- **WHEN** the example initiative body from the brief is parsed and serialized
- **THEN** the output equals the input byte for byte

#### Scenario: Change entries
- **WHEN** the list has `- [ ] #35 per-ip-cap — Depends: #34`
- **THEN** the entry has number 35, name `per-ip-cap` and depends `[#34]`

### Requirement: Unit digest
The system SHALL provide `unitDigest(unit)` returning the sha256 of the unit's contract: every field except the status line, `Difficulty` and `Tags`, normalized to LF endings and trimmed trailing whitespace, in canonical field order.

#### Scenario: Digest stable under reserialization
- **WHEN** a unit is parsed, serialized and parsed again
- **THEN** both parses give the same digest

#### Scenario: Difficulty and Tags excluded
- **WHEN** only `Difficulty` or `Tags` of a unit changes
- **THEN** the digest is unchanged

#### Scenario: Status excluded
- **WHEN** a unit is ticked
- **THEN** its digest is unchanged

#### Scenario: Contract change alters digest
- **WHEN** a `Done means` item changes
- **THEN** the digest differs

#### Scenario: Whitespace normalization
- **WHEN** a unit has CRLF endings or trailing spaces on field lines
- **THEN** its digest equals the digest of the same unit with LF endings and no trailing spaces

### Requirement: Tick and untick units
`tickUnit` SHALL change exactly one unit's status line from `- [ ] pending` to `- [x] done` and leave every other byte unchanged. `untickUnit` SHALL do the reverse. Any other difference or an unexpected state SHALL be an error.

#### Scenario: Tick changes one line
- **WHEN** `tickUnit(body, "U3")` runs on the example body
- **THEN** the result differs from the input only in U3's status line

#### Scenario: Tick an already done unit
- **WHEN** `tickUnit` runs on a unit already marked done
- **THEN** it returns an error and no text

#### Scenario: Unknown unit
- **WHEN** `tickUnit` is given an id that does not exist
- **THEN** it returns an error

#### Scenario: Untick restores bytes
- **WHEN** `untickUnit` runs on the result of `tickUnit`
- **THEN** the output equals the original input

### Requirement: Tick and untick changes
`tickChange` and `untickChange` SHALL flip the checkbox of exactly one line in an initiative's `## Changes` list, identified by issue number, leaving every other byte unchanged.

#### Scenario: Tick one change line
- **WHEN** `tickChange(body, 34)` runs on the example initiative
- **THEN** only the line for #34 changes from `- [ ]` to `- [x]`

#### Scenario: Missing change
- **WHEN** the number is not in the list
- **THEN** it returns an error
