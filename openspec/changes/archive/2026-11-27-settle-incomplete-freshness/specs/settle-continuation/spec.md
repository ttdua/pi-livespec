## MODIFIED Requirements

### Requirement: Incomplete marker
Clearing does not depend on the phase. At every settle with outcome `completed`, when a change is resolved, its latest `incomplete` comment lists items, and no unfinished item holds, the hook SHALL clear that comment, even after the change has moved past `build`. Items are compared as ordered lists. When unfinished items remain at the settle after the continuation, and they differ from the items of the latest `incomplete` comment or no such comment lists items, the hook SHALL write an own `incomplete` comment with id `<change number>` and data `{ items, at, head_sha }`, editing the existing one in place. At a settle that requests a continuation, when the latest `incomplete` comment lists items and the unfinished items differ from them, the hook SHALL edit that comment to the current items; when no comment lists items, it MUST NOT write one before the continuation. A failure of that edit MUST NOT cancel the continuation. When the unfinished items equal the recorded ones, the hook MUST NOT write. When a later settle finds no unfinished item, it SHALL edit that comment to an empty item list. The change state SHALL expose the items of the latest `incomplete` comment. The phase card and the step text of `spec_next` and `/livespec next` SHALL show them as flow-engine "Next step" reconciles them, labelled `Incomplete (may be stale)` instead of `Incomplete` while the change state is stale or read-only. When the forge is read-only or not writable, the hook MUST NOT write and SHALL record a warning; it SHALL notify the user only as the next sentence states. When the change state is read-only or stale and its recorded items are non-empty, or when a write is refused or fails, the hook SHALL also notify the user with a warning naming the change and the reason the comment was not updated; a refused or failed write MUST NOT throw into pi and MUST NOT cancel a continuation the settle requests. When the forge is unavailable and no change state was read, the hook SHALL only record a warning.

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
- **WHEN** an `incomplete` comment lists U2 and the forge is in read-only mode at a settle
- **THEN** no comment is written, a warning is recorded, and the user is notified that the incomplete comment of the change was not updated

#### Scenario: Rewritten at the continuation settle
- **WHEN** an `incomplete` comment lists `U2 is started`, and in a new prompt U2 gets its receipt and U3 and U4 are started before the agent first settles
- **THEN** that settle requests one continuation and edits the comment to list `U3 is started` and `U4 is started`, not U2

#### Scenario: No first comment before the continuation
- **WHEN** no `incomplete` comment exists and U2 is started at the first settle of a prompt
- **THEN** the hook requests a continuation and writes no comment

#### Scenario: Equal items are not rewritten
- **WHEN** an `incomplete` comment lists `U2 is started` and U2 is still the only unfinished item at the settle after the continuation
- **THEN** the comment is not edited

#### Scenario: Refused write is notified
- **WHEN** an `incomplete` comment lists items, the next settle finds none on a fresh change state, and the session's account check refuses the write
- **THEN** the comment is not edited, a warning is recorded, and the user is notified with the reason

#### Scenario: Rewritten after the continuation
- **WHEN** an `incomplete` comment lists `U2 is started`, and at the settle after the continuation U2 is finished and U3 is started
- **THEN** the comment is edited to list `U3 is started` only

#### Scenario: Failed rewrite keeps the continuation
- **WHEN** an `incomplete` comment lists `U2 is started`, U3 is started at the first settle of a prompt, and editing the comment fails
- **THEN** the hook still requests the continuation, records the failure and notifies the user

#### Scenario: Stale state is notified
- **WHEN** an `incomplete` comment lists `U2 is started` and the change state is stale at a settle
- **THEN** nothing is written, no continuation is requested, a warning is recorded, and the user is notified

#### Scenario: Unknown state without items is quiet
- **WHEN** no `incomplete` comment lists items and the change state is read-only at a settle
- **THEN** a warning is recorded and the user is not notified

#### Scenario: Step text labels possibly stale items
- **WHEN** the latest `incomplete` comment lists `U2 is started`, U2 is still started, and the change state is stale
- **THEN** `spec_next` shows `Incomplete (may be stale):` with U2
