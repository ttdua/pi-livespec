## ADDED Requirements

### Requirement: Forge read tool
`forge_read` SHALL be a read-only tool of the main session with one `target` of: `issue` (number), `comments` (issue number), `pr` (number), `pr-files` (number), `reviews` (number), `review-comments` (number), `checks` (ref), or `search` (labels or text). It SHALL read through the `Forge` interface and MUST NOT call any write method. Each item SHALL be returned with its source id and version.

#### Scenario: Read comments
- **WHEN** `forge_read` is called with `target: comments, number: 12`
- **THEN** it returns the comments of issue 12, each with `comment:<id>` and its `updatedAt`

#### Scenario: Unknown target
- **WHEN** `forge_read` is called with `target: labels-edit`
- **THEN** it refuses and lists the allowed targets

### Requirement: Untrusted text in reads
Text authored by humans in a `forge_read` result SHALL be wrapped with `<untrusted>`, and only own marked comments SHALL be presented as state.

#### Scenario: Human comment
- **WHEN** `forge_read` returns a comment without an own marker
- **THEN** its body is inside `<untrusted>…</untrusted>`

### Requirement: Forge read in children
`forge_read` MUST refuse in a child session and say that children read their packet and its spill files.

#### Scenario: Called by a child
- **WHEN** a child session calls `forge_read`
- **THEN** it refuses with that message and reads nothing
