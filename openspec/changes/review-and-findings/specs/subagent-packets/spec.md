## MODIFIED Requirements

### Requirement: Context manifest
Each role and subject SHALL have a list of required sources:
- `implementer`: the unit; the requirements it covers; `specs/constraints.md`; answered questions that mention the unit id, a covered requirement or one of its `Files`; the notes of the plan gate; earlier findings on the unit, including aggregate review findings routed to it; the receipts and `dispatch` records of the units it depends on; issues referenced as `#N` in the unit, one hop; review comments on its `Files`.
- `reviewer` with subject `unit`, `change` or `persona:<name>`: the diff, as a file; the specs; the units; the receipts; the change issue; every answered question; the decision records; review comments and checks once a pull request exists. A `change` packet SHALL also hold the persona file `agents/code-reviewer.md`, and a `persona:<name>` packet `agents/<name>.md`, from the active content tree, as source `file:agents/<name>.md`; a missing persona file MUST refuse the dispatch, naming it. A reviewer packet MUST NOT hold another reviewer's `finding-summary` of the same round or a verifier record.
- `reviewer` with subject `spec`: the specs diff of the change against its base, as a file; the `Capabilities` section; the issue and its initiative; the related living specs; the closing summary comment of each closed change of the same capability.
- `reviewer` with subject `plan`: the `Units` section; the specs diff, as a file; the issue and its initiative; the related living specs; the closing summary comments as for `spec`.
- `verifier`: the referenced aggregate finding; the code at its location; the unit that owns the file and that unit's receipts, when a unit owns it. A finding at a file no unit owns SHALL be verified without the unit source.
- `scout`: the initiative; closed issues and pull requests of the same capability or touching the same `paths`.

Every packet SHALL also hold the relevant excerpt of `specs/product.md`, and every `reviewer` packet the rubric of its subject.

#### Scenario: Answered question included
- **WHEN** Q2 is answered and mentions `src/api/limit.ts`, one of U3's `Files`
- **THEN** U3's implementer packet holds `answer:Q2` as a required source

#### Scenario: Spec review sees the diff
- **WHEN** a `reviewer` packet with subject `spec` is built
- **THEN** it lists the change's specs diff file and the `Capabilities` section as required sources

#### Scenario: Diff as a file
- **WHEN** a `reviewer` packet with subject `unit` is built for U3
- **THEN** U3's diff since its `unit-start` SHA is written to a file, and the packet lists that file as source `diff:<from>..<to>`

#### Scenario: Persona file
- **WHEN** a `reviewer` packet with subject `persona:security-auditor` is built
- **THEN** it lists `file:agents/security-auditor.md` from the active content tree as a required source

#### Scenario: Verifier of an in-change finding
- **WHEN** a verifier packet is built for an aggregate finding at `src/util/clock.ts:4`, which no unit lists
- **THEN** the packet holds the finding and the code at `src/util/clock.ts`, and the dispatch is not refused
