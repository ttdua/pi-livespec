## MODIFIED Requirements

### Requirement: Context manifest
Each role and subject SHALL have a list of sources; every source SHALL be required unless this requirement names it optional:
- `implementer`: the unit; the requirements it covers; `specs/constraints.md`; answered questions that mention the unit id, a covered requirement or one of its `Files`; the notes of the plan gate; earlier findings on the unit, including aggregate review findings routed to it; the receipts and `dispatch` records of the units it depends on; answers the parent gave to a child of the unit, each as source `answer:<agentId>:<n>`; issues referenced as `#N` in the unit, one hop; review comments on its `Files`.
- `reviewer` with subject `unit`, `change` or `persona:<name>`: the diff, as a file; the specs; the units; the receipts; the change issue; every answered question; review comments and checks once a pull request exists. It SHALL also hold, as optional sources, every `decision` record grouped into one source `records:decisions`, and every answer the parent gave to a child of the change grouped into one source `records:dispatch-answers`; a grouped source SHALL be left out when it has no record, and its text SHALL name each record by the id it would have alone (`comment:<id>` or `answer:<agentId>:<n>`), so an answer that `subagent_answer` records as source `answer:<id>:<n>` reaches a reviewer packet inside `records:dispatch-answers`. The number of decision records and parent answers MUST NOT change the list of required source ids. A `change` packet SHALL also hold, when the change has behavior items, the required source `records:behavior-conclusions` of durable-doc-checks "Behavior conclusions in the reviewer packet"; it is one source whatever the number of items, so the number of decision records still does not change the list of required ids. A `change` packet SHALL also hold the persona file `agents/code-reviewer.md`, and a `persona:<name>` packet `agents/<name>.md`, from the active content tree, as source `file:agents/<name>.md`; a missing persona file MUST refuse the dispatch, naming it. A reviewer packet MUST NOT hold another reviewer's `finding-summary` of the same round or a verifier record.
- `reviewer` with subject `spec`: the specs diff of the change against its base, as a file; the `Capabilities` section; the issue and its initiative; the related living specs; the closing summary comment of each closed change of the same capability.
- `reviewer` with subject `plan`: the `Units` section; the specs diff, as a file; the issue and its initiative; the related living specs; the closing summary comments as for `spec`.
- `verifier`: the referenced aggregate finding; the code at its location; the unit that owns the file and that unit's receipts, when a unit owns it. A finding at a file no unit owns SHALL be verified without the unit source.
- `scout`: the initiative; closed issues and pull requests of the same capability or touching the same `paths`.

Every packet SHALL also hold the relevant excerpt of `specs/product.md`, and every `reviewer` packet the rubric of its subject.

Every `implementer` and `reviewer` packet SHALL also hold, as durable doc readers:
- `specs/constraints.md`, when it exists;
- as source `file:specs/glossary.md`, the glossary entries whose term occurs, ignoring case and on word boundaries, in the unit text (implementer, and reviewer with subject `unit`) or in the `## Units` section (other reviewer subjects); the source is left out when no term occurs;
- each accepted decision with `spine: true`, as source `file:specs/decisions/<file>`;
- each accepted decision whose `capabilities` names a capability the change declares, as source `file:specs/decisions/<file>`.

A `superseded` decision MUST NOT be included by these readers.

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

#### Scenario: Glossary entries for the unit
- **WHEN** the glossary has `Token bucket` and `Receipt`, and U2's text mentions `token bucket` but not `receipt`
- **THEN** U2's implementer packet holds `file:specs/glossary.md` with the `Token bucket` entry only

#### Scenario: Spine and capability decisions
- **WHEN** `0001-a.md` is accepted with `spine: true`, `0003-c.md` is accepted with `capabilities: [rate-limit]`, `0004-d.md` is superseded with `capabilities: [rate-limit]`, and the change declares `modified [rate-limit]`
- **THEN** an implementer packet holds `file:specs/decisions/0001-a.md` and `file:specs/decisions/0003-c.md`, and not `0004-d.md`

#### Scenario: Reviewer sees constraints
- **WHEN** a `reviewer` packet with subject `change` is built and `specs/constraints.md` exists
- **THEN** it lists `file:specs/constraints.md` as a required source

#### Scenario: Records do not grow the required list
- **WHEN** a `reviewer` packet with subject `change` is built for a change with 30 `decision` records and 15 parent answers, and again for the same change with none
- **THEN** both packets have the same required source ids, the first also holds the optional sources `records:decisions` and `records:dispatch-answers`, and the second holds neither

#### Scenario: Grouped records keep their ids
- **WHEN** a `reviewer` packet with subject `unit` is built and decision record comment 501 exists
- **THEN** the text of `records:decisions` names `comment:501` and holds that record inside `<untrusted>`, and the packet holds no source `comment:501`

#### Scenario: Behavior conclusions required for change review
- **WHEN** a `change` reviewer packet is built for a change with behavior items for `rate-limit` and `forge-read`
- **THEN** its required sources hold `records:behavior-conclusions` once, and a `unit` reviewer packet of the same change does not hold it

#### Scenario: Implementer answers stay required
- **WHEN** the parent answered U3's implementer child `agent-1` once and U3's implementer packet is built again
- **THEN** it holds `answer:agent-1:1` as a required source and no `records:dispatch-answers`

