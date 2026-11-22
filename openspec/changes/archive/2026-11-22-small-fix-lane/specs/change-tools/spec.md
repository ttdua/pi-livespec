## MODIFIED Requirements

### Requirement: Status and next tools
`spec_status` SHALL return the current change state (change, phase, units, questions, counters, check results and the stale flag) as text and structured details. `spec_next` and `/livespec next` SHALL return the next-step sentence and its supporting lists. All three SHALL rebuild the snapshot before answering. On a fix branch all three SHALL return the fix slug, the lane outcome and the next step of small-fix-lane "Fix card". Without a resolvable change on any other branch they SHALL return the list of open changes.

#### Scenario: Status mid-change
- **WHEN** `spec_status` is called on `livespec/per-ip-cap` with U1 done and U3 pending
- **THEN** the result shows phase, U1 done and U3 pending in text and details

#### Scenario: Next command matches tool
- **WHEN** `/livespec next` and `spec_next` run on the same state
- **THEN** both show the same next-step sentence

#### Scenario: No change
- **WHEN** `spec_next` is called on `main`
- **THEN** it returns the open changes and a sentence to start or switch to one

#### Scenario: Next on a fix branch
- **WHEN** `spec_next` is called on `fix/typo` with lane outcome `small`
- **THEN** it returns the next step `fix_ship`, the same as the fix card

### Requirement: Change new tool
Without `from_fix`, `change_new <name>` SHALL create only the change issue: its title is the kebab-case name, its labels are `livespec` and `livespec:phase/shape`, and its body starts with the lines `Depends: —`, `Capabilities: new [], modified []` and `Product impact: —`, followed by empty `Proposal`, `Design`, `Questions`, `Units` and `Durable docs` sections. It MUST NOT create or rename a branch. It MUST refuse a name that is not kebab-case or that equals the title of an open `livespec` issue. With the parameter `from_fix: true` (written `--from-fix`) it SHALL instead behave as small-fix-lane "Move a fix into a change".

#### Scenario: Create change
- **WHEN** `change_new rate-limit` is called
- **THEN** one issue titled `rate-limit` exists with labels `livespec` and `livespec:phase/shape`, `parseChange` of its body gives `depends: []`, `capabilities: { new: [], modified: [] }` and `productImpact: "—"`, and no branch is created

#### Scenario: Duplicate name
- **WHEN** an open `livespec` issue titled `rate-limit` exists and `change_new rate-limit` is called
- **THEN** the tool refuses and creates nothing

#### Scenario: From a fix
- **WHEN** `change_new` is called with `name: rate-limit` and `from_fix: true` on `fix/limit`
- **THEN** the issue is created in `livespec:phase/define` and the branch is renamed to `livespec/rate-limit`
