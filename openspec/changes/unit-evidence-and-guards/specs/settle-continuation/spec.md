## ADDED Requirements

### Requirement: Settle conditions
At `agent_before_settle` with outcome `completed`, the extension SHALL refresh the change state and collect the unfinished items when two things hold: a change is resolved, and the change is in a `per: unit` phase or has a started unit. The items are:
- each started unit;
- a dirty working tree;
- each message returned by a condition registered with `registerSettleCondition(name, fn)`.

Outside those cases it MUST NOT request a continuation or write unfinished items; clearing an `incomplete` comment follows "Incomplete marker" in every phase. An `aborted` or `error` outcome MUST be left alone. The hook MUST NOT throw into pi.

#### Scenario: Not in build
- **WHEN** the change is in `define` with no started unit and the tree is dirty
- **THEN** the hook requests no continuation and posts nothing

#### Scenario: Registered condition
- **WHEN** a test registers a condition that reports `review pending for U2` and the change is in `build`
- **THEN** the continuation list contains `review pending for U2`

### Requirement: One continuation
When unfinished items exist and no continuation was requested since the agent last settled, the hook SHALL append one displayed custom message listing the items and request one continuation. It MUST NOT request a second continuation before the agent settles.

#### Scenario: Exactly one continuation
- **WHEN** U2 is started at the end of a run, and is still started at the end of the continuation
- **THEN** the hook requested a continuation once, and the second settle requests none and lets the agent settle

#### Scenario: New prompt gets a new continuation
- **WHEN** the agent settled with U2 started and the user sends a new prompt, after which U2 is still started
- **THEN** the hook requests one continuation again

### Requirement: Incomplete marker
Clearing does not depend on the phase. At every settle with outcome `completed`, when a change is resolved, its latest `incomplete` comment lists items, and no unfinished item holds, the hook SHALL clear that comment, even after the change has moved past `build`. When unfinished items remain at the settle after the continuation, the hook SHALL write an own `incomplete` comment with id `<change number>` and data `{ items, at, head_sha }`, editing the existing one in place. When a later settle finds no unfinished item, it SHALL edit that comment to an empty item list. The change state SHALL expose the items of the latest `incomplete` comment, and the phase card SHALL show them. When the forge is read-only or not writable, the hook MUST NOT write and SHALL record a warning.

#### Scenario: Incomplete posted and shown
- **WHEN** U2 is still started after the continuation
- **THEN** an `incomplete` comment lists U2, and the next session's phase card shows `Incomplete:` with U2

#### Scenario: Cleared after finishing
- **WHEN** an `incomplete` comment lists U2, and a later run ends with U2 finished and a clean tree
- **THEN** the comment is edited to an empty list and the card shows no `Incomplete:` line

#### Scenario: Cleared after the phase moved on
- **WHEN** an `incomplete` comment lists U2, and `unit_finish U2` ticks the last unit so that the change moves to `review`
- **THEN** the next settle clears the comment and requests no continuation

#### Scenario: Read-only forge
- **WHEN** the forge is in read-only mode at the second settle
- **THEN** no comment is written and a warning is recorded
