# change-tools Specification

## Purpose

Defines the change tools and commands exposed to the model and the user: `spec_status`, `spec_next`, `/livespec next`, `skill_note`, `spec_write`, `change_new` and `change_start`.

## Requirements

### Requirement: Status and next tools
`spec_status` SHALL return the current change state (change, phase, units, questions, counters, check results and the stale flag) as text and structured details. `spec_next` and `/livespec next` SHALL return the next-step sentence and its supporting lists. All three SHALL rebuild the snapshot before answering. Without a resolvable change they SHALL return the list of open changes.

#### Scenario: Status mid-change
- **WHEN** `spec_status` is called on `livespec/per-ip-cap` with U1 done and U3 pending
- **THEN** the result shows phase, U1 done and U3 pending in text and details

#### Scenario: Next command matches tool
- **WHEN** `/livespec next` and `spec_next` run on the same state
- **THEN** both show the same next-step sentence

#### Scenario: No change
- **WHEN** `spec_next` is called on `main`
- **THEN** it returns the open changes and a sentence to start or switch to one

### Requirement: Spec write tool
After a change issue is created, `spec_write` SHALL be the only tool that writes the `Capabilities` and `Product impact` lines and the `## Proposal` and `## Design` sections of the change issue body. It SHALL write the section with the version it read, and every line outside the written section MUST stay byte-identical. On a version conflict it MUST write nothing and report the conflict.

#### Scenario: Write proposal
- **WHEN** `spec_write` writes the `Proposal` of the fixture change body
- **THEN** the issue body has the new Proposal and every other line is byte-identical

#### Scenario: Create missing section
- **WHEN** the body has no `## Design` and `spec_write` writes `Design`
- **THEN** `## Design` is added after `## Proposal`

#### Scenario: Conflict
- **WHEN** the issue body changes between the tool's read and its write
- **THEN** nothing is written and the result reports the conflict

### Requirement: Spec write validation
`spec_write` MUST validate the content before writing: `Capabilities` as `new [..], modified [..]` with kebab-case names, and `Proposal` and `Design` non-empty with no level-2 heading. The resulting body MUST still parse as a change. A section other than the four MUST be refused.

#### Scenario: Invalid capabilities
- **WHEN** `spec_write` is called for `Capabilities` with `new [Rate Limit]`
- **THEN** the tool refuses with a validation error and writes nothing

#### Scenario: Heading inside content
- **WHEN** the `Design` content contains a line starting with `## `
- **THEN** the tool refuses and writes nothing

#### Scenario: Unsupported section
- **WHEN** `spec_write` is called for `Units`
- **THEN** the tool refuses and names the tool that will own that section

### Requirement: Change new tool
`change_new <name>` SHALL create only the change issue: its title is the kebab-case name, its labels are `livespec` and `livespec:phase/shape`, and its body starts with the lines `Depends: —`, `Capabilities: new [], modified []` and `Product impact: —`, followed by empty `Proposal`, `Design`, `Questions`, `Units` and `Durable docs` sections. It MUST NOT create a branch. It MUST refuse a name that is not kebab-case or that equals the title of an open `livespec` issue.

#### Scenario: Create change
- **WHEN** `change_new rate-limit` is called
- **THEN** one issue titled `rate-limit` exists with labels `livespec` and `livespec:phase/shape`, `parseChange` of its body gives `depends: []`, `capabilities: { new: [], modified: [] }` and `productImpact: "—"`, and no branch is created

#### Scenario: Duplicate name
- **WHEN** an open `livespec` issue titled `rate-limit` exists and `change_new rate-limit` is called
- **THEN** the tool refuses and creates nothing

### Requirement: Change start tool
`change_start #N` SHALL fetch the integration branch from `origin`, create and switch to the local branch `livespec/<name>` at the fetched head, store that head in the git config key `branch.livespec/<name>.livespecBase`, and record `Branch: livespec/<name>` and `Base: <full sha>` in the issue body with a version check. It MUST NOT push.

#### Scenario: Start change
- **WHEN** `change_start #7` is called for open change `rate-limit` on a clean tree whose `origin/main` head is S
- **THEN** the current branch is `livespec/rate-limit` at S and the issue has `Branch: livespec/rate-limit` and `Base: S`

#### Scenario: No push
- **WHEN** `change_start` succeeds
- **THEN** no push to any remote was made

### Requirement: Change start refusals
`change_start #N` MUST refuse, without creating a branch, when the tree is dirty, the issue is not an open `livespec` change, or the issue already has a `Branch` line and no reconciliation applies.

#### Scenario: Dirty tree
- **WHEN** the working tree has uncommitted changes
- **THEN** the tool refuses and creates no branch

#### Scenario: Already started
- **WHEN** the issue already has a `Branch` line and no local `livespec/<name>` branch with `livespecBase` exists
- **THEN** the tool refuses and changes nothing

### Requirement: Change start write failure
Only a version conflict SHALL count as a definite rejection of the `change_start` issue write; then the tool MUST switch back and delete the branch it created. Any thrown error MUST be treated as an unknown outcome: the tool MUST re-read the issue and succeed only if `Branch` and `Base` equal the values it wrote; otherwise, or if the re-read fails, it MUST keep the branch and say that rerunning `change_start #N` will reconcile.

#### Scenario: Write failure rolls back
- **WHEN** the issue body write returns a conflict
- **THEN** the previous branch is checked out again and `livespec/rate-limit` no longer exists

#### Scenario: Write lost in transit
- **WHEN** the forge stores the body but the write call fails as unreachable, and the re-read succeeds
- **THEN** the tool reports success and the branch is kept

#### Scenario: Outcome unknown
- **WHEN** the write call fails as `readonly` through the cached forge and the re-read also fails
- **THEN** the branch is kept and the result tells the user to rerun `change_start #N` once the forge is reachable

#### Scenario: Unreadable success response
- **WHEN** the forge stores the body but the write call throws `http` because the response cannot be parsed, and the re-read shows the written values
- **THEN** the tool reports success and the branch is kept

### Requirement: Change start reconciliation
When the local branch `livespec/<name>` already exists and carries `branch.livespec/<name>.livespecBase`, `change_start #N` SHALL reconcile instead of creating a branch: if the issue records exactly that branch and base, it SHALL switch to the branch and succeed without a write; if the issue has no `Branch` line, it SHALL write `Branch` and that base with a version check; any other combination MUST be refused without deleting the branch. A local branch without that config key MUST be refused.

#### Scenario: Server wrote before the failure
- **WHEN** a previous run kept the branch and the issue already records the same `Branch` and `Base`
- **THEN** rerunning `change_start #N` succeeds without a write

#### Scenario: Server did not write
- **WHEN** a previous run kept the branch and the issue has no `Branch` line
- **THEN** rerunning `change_start #N` writes `Branch` and the recorded base and succeeds

#### Scenario: Mismatch
- **WHEN** the issue records a different `Base` than the branch config
- **THEN** the tool refuses, names both values, and keeps the branch

### Requirement: Read-only refusal
Every livespec tool that writes to the forge SHALL refuse with a clear message while the forge is in read-only mode or no forge is available, and MUST NOT run any git command that changes branches in that case.

#### Scenario: Read-only
- **WHEN** the forge is unreachable and `change_start` is called
- **THEN** the tool refuses, explains read-only mode, and the current branch is unchanged
