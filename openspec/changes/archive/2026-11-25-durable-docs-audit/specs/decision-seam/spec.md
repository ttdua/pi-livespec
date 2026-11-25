## MODIFIED Requirements

### Requirement: Decision records
Every decision of a change SHALL be recorded as a `decision` comment with id `<point>.<subject>` and these YAML fields:
- `point`, `subject`, the unit digest when the subject is a unit, `source`, `outcome` and `reason`;
- `facts`, or `facts_hash` when the facts' YAML exceeds 2,000 characters;
- for point `behavior-change`, `files`: the item's files, kept when `facts` becomes `facts_hash`;
- `agent_additions`;
- `overridden_by`.

The latest record for an id SHALL win, except that a record with `proposal: true` MUST NOT count as the current decision of a unit (for the `unit-classification` check and gate payloads); it only serves the reuse of an answer. Only tools MUST write outcomes into the issue body. A `lane` decision on a fix branch, which has no issue, SHALL be recorded only as the pull request body block of "Small-fix decision block" when `fix_ship` opens or updates the pull request; a `lane` outcome shown on the fix card is not recorded.

#### Scenario: Record fields
- **WHEN** `plan_units` writes U3 with tags `[security, api]` where the agent added `api`
- **THEN** the `decision` comment `tags.U3` has source `rule`, outcome `[security, api]` and `agent_additions: [api]`

#### Scenario: Large facts hashed
- **WHEN** a decision's facts serialize to more than 2,000 characters of YAML
- **THEN** the record holds `facts_hash` and no `facts`

#### Scenario: Lane decision in the pull request only
- **WHEN** `fix_ship` opens a pull request for `fix/typo`
- **THEN** the `lane` record is in the pull request body and no `decision` comment is written to any issue

#### Scenario: Proposal record is not current
- **WHEN** `difficulty.U1` has a rule record `low` for U1's digest followed by a human record `high` with `proposal: true` for the same digest
- **THEN** the current `difficulty` decision of U1 is the rule record `low`

#### Scenario: Behavior files kept with hashed facts
- **WHEN** a `behavior-change` record's facts serialize to more than 2,000 characters of YAML
- **THEN** the record holds `facts_hash`, no `facts`, and the full `files` list
