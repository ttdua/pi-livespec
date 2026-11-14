## ADDED Requirements

### Requirement: Byte-exact round trip
Every parser in this capability SHALL be paired with a serializer so that parsing a document and serializing it unchanged returns the identical bytes, including line endings and sections the parser does not know.

#### Scenario: Living spec round trip
- **WHEN** the example living spec from the LS-02 brief is parsed and serialized
- **THEN** the output equals the input byte for byte

#### Scenario: Unknown section preserved
- **WHEN** a living spec contains a `## Notes` section the parser does not know
- **THEN** serializing the parsed document keeps that section unchanged

#### Scenario: CRLF preserved
- **WHEN** a document with CRLF line endings is parsed and serialized
- **THEN** the output still has CRLF line endings at the same lines

### Requirement: Living spec format
The system SHALL parse `specs/<capability>/spec.md` into the capability name (the directory name), optional front matter `paths` (list of globs), the Purpose text, and the list of requirements, each with its name, text and scenarios (name, WHEN lines, THEN lines).

#### Scenario: Requirements and scenarios extracted
- **WHEN** the example `rate-limit` spec is parsed
- **THEN** it has one requirement named `Per-IP cap` with one scenario `rejects 101st request` that has one WHEN and one THEN

#### Scenario: Paths read from front matter
- **WHEN** the front matter lists `paths: ["src/limits/**"]`
- **THEN** the parsed spec exposes that glob list

#### Scenario: No front matter
- **WHEN** a spec has no front matter
- **THEN** `paths` is empty and parsing succeeds

### Requirement: Decision record format
The system SHALL parse `specs/decisions/NNNN-<slug>.md` front matter: `status` (`accepted` or `superseded`), `superseded_by` (a decision number), optional `spine` (boolean) and optional `capabilities` (list), plus the number and slug from the file name.

#### Scenario: Superseded decision
- **WHEN** `0002-x.md` has `status: superseded` and `superseded_by: 5`
- **THEN** the parsed decision has number 2, status `superseded` and `superseded_by` 5

#### Scenario: Optional fields absent
- **WHEN** a decision has only `status: accepted`
- **THEN** `spine` is false and `capabilities` is empty

### Requirement: Glossary format
The system SHALL parse `specs/glossary.md` into entries from lines of the form `- **Term**: definition`, preserving every other line.

#### Scenario: Entries parsed in order
- **WHEN** a glossary has the lines `- **Change**: a unit of work` and `- **Unit**: a slice of a change`
- **THEN** two entries are returned in that order with their definitions

#### Scenario: Other lines preserved
- **WHEN** a glossary has a heading and a blank line
- **THEN** serializing the parsed glossary keeps them unchanged

### Requirement: Bare-work log format
The system SHALL parse `specs/bare-work.md` into one entry per non-blank line carrying a date, files and summary, and SHALL serialize it back byte for byte.

#### Scenario: Line parsed
- **WHEN** a line records a date, two files and a summary
- **THEN** the entry exposes those three parts

### Requirement: Free-text durable files
`specs/product.md` and `specs/constraints.md` SHALL be treated as free text: they are read and written as opaque documents with no structural checks.

#### Scenario: Free text passes through
- **WHEN** `specs/product.md` has arbitrary Markdown
- **THEN** parsing and serializing returns it unchanged and validation reports nothing for its content

### Requirement: Glob matching
The system SHALL provide `matchGlob(pattern, path)` supporting `*`, `**`, `?`, `{a,b}` and `[...]` without adding a dependency, and a check that reports a syntactically invalid glob.

#### Scenario: Double star spans directories
- **WHEN** `matchGlob("src/limits/**", "src/limits/a/b.ts")` is evaluated
- **THEN** it returns true

#### Scenario: Single star stays in one segment
- **WHEN** `matchGlob("src/*.ts", "src/a/b.ts")` is evaluated
- **THEN** it returns false

#### Scenario: Invalid glob detected
- **WHEN** the glob `src/{a,b` is checked
- **THEN** it is reported as invalid
