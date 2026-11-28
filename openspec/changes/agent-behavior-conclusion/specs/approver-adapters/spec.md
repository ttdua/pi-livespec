## MODIFIED Requirements

### Requirement: Forge command comments
The forge adapter SHALL read answers only from plain comments whose first line starts with `/livespec `, created after the request, and SHALL accept these commands:
- `approve [notes]`
- `changes <notes>`
- `dismiss [notes]`
- `choose <option-id> [notes]`
- `answer Q<n> <text>`
- `set U<n> difficulty <low|medium|high>`
- `set U<n> tags <a,b,…>`
- `set behavior <capability> changed`

An `answer` command that contains the removed `--changes` flag MUST NOT answer the question; it SHALL be treated as a comment that cannot be parsed, and its card warning SHALL say that `--changes` was removed and that requirement changes now follow from spec edits.

An answer SHALL count only when `getPermission(author)` returns `write` or `admin`. A comment from an author without that permission, created before the request, that cannot be parsed, or that is ambiguous among pending requests MUST be ignored and reported as a card warning naming the reason. A comment whose author is the plugin's own login SHALL be accepted like any other.

The question class is not a human choice: `/livespec class` and the `--class` flag of `answer` MUST be reported as unparseable and ignored, and own `class` comments written before this rule MUST be ignored.

#### Scenario: Behavior override command parsed
- **WHEN** a writer comments `/livespec set behavior rate-limit changed` on a pending `gate:define` request whose behavior items include `rate-limit`
- **THEN** the override is collected for that request, and the request stays pending until an outcome command

#### Scenario: Behavior override with another value
- **WHEN** a writer comments `/livespec set behavior rate-limit unchanged`
- **THEN** the comment is ignored with a card warning that only `changed` can be set

#### Scenario: Approve by a writer
- **WHEN** a user with `write` permission comments `/livespec approve looks good` after a pending `gate:define` request
- **THEN** the next poll completes the gate with `approved_with_notes`, notes `looks good`, and `by` that user

#### Scenario: Command without write access ignored
- **WHEN** a user with `read` permission comments `/livespec approve` on a pending gate request
- **THEN** the request stays pending and the card warns that the comment was ignored for missing write access

#### Scenario: Command before the request ignored
- **WHEN** a `/livespec approve` comment was created before the pending request
- **THEN** it does not answer the request

#### Scenario: Answer that changes a requirement
- **WHEN** a writer comments `/livespec answer Q2 use per-user limits --changes rate-limit/Requirement: Per-IP cap` on Q2's pending request
- **THEN** Q2 stays open, its request stays pending, and the card warns that `--changes` was removed

#### Scenario: Answer with a class
- **WHEN** a writer comments `/livespec answer Q2 use per-user limits --class non-blocking` on Q2's pending request
- **THEN** Q2 stays open, its request stays pending, and the card warns that the comment could not be parsed

#### Scenario: Class command applied once
- **WHEN** a writer comments `/livespec class Q2 non-blocking` while Q2 is `(blocking)` and its request is pending, and a poll runs
- **THEN** Q2 stays `(blocking)`, no `class` comment is written, and the card warns that the comment could not be parsed

#### Scenario: Class command recorded across sessions
- **WHEN** an own `class` comment written before this rule records `/livespec class Q2 non-blocking`, Q2 reads `(blocking)`, and a new session polls while Q2's request is pending
- **THEN** Q2 stays `(blocking)`

#### Scenario: Class command already matching
- **WHEN** Q2 is `(non-blocking)` and a writer comments `/livespec class Q2 blocking`
- **THEN** Q2 stays `(non-blocking)` and no `class` comment is written

#### Scenario: Class rewrite conflict retried
- **WHEN** a writer comments `/livespec class Q2 non-blocking` and the next poll runs
- **THEN** the issue body is not written for Q2

### Requirement: In-session dialog
The dialog SHALL show one request on tabs: Decision and Review. With overridable behavior ("Behavior overrides"), the Decision tab SHALL show a key hint, and pressing `b` there, at any width and with no editor open, SHALL add the Behavior tab before Review and switch to it; the tab lists each overridable capability with its current outcome and lets the human mark it `changed`. With overridable units, the Decision tab SHALL show a key hint, and pressing `u` there, at any width and with no editor open, SHALL add the Adjust units tab between Decision and Review and switch to it; the tab is not shown before. The `select` fallback keeps its "Keep classification" step. Decision SHALL show the entries as request-briefing "In-session presentation" defines; the first nine MAY be picked by number. Every answer SHALL pass the Review tab and SHALL be sent only when the human submits it there. The Review tab SHALL show what will be sent: outcome, option, notes, overrides, and for a question the answer.

#### Scenario: Approve through Review
- **WHEN** a define gate is shown in the dialog, and the human picks approve and submits on the Review tab
- **THEN** the outcome is `approved`

#### Scenario: Review shows the answer before it is sent
- **WHEN** the human picks the `waive` option of a gate with a failing waivable check and moves to the Review tab
- **THEN** the Review tab shows the waive choice and no answer is recorded until the human submits

#### Scenario: No unit tab without overridable units
- **WHEN** a define gate for a change with no behavior item is shown in the dialog
- **THEN** the dialog has the Decision and Review tabs only

#### Scenario: Behavior tab opened with one key
- **WHEN** a define gate with behavior item `rate-limit` concluded `unchanged` is shown in the dialog and the human presses `b` on the Decision tab
- **THEN** the Behavior tab is shown and selected, listing `rate-limit` as `unchanged`

#### Scenario: Units tab hidden by default
- **WHEN** a plan gate with units U1 and U2 is shown in the dialog
- **THEN** the dialog has the Decision and Review tabs only, and the Decision tab shows the `u` key hint

#### Scenario: Units tab opened with one key
- **WHEN** a plan gate with units U1 and U2 is shown in the dialog and the human presses `u` on the Decision tab
- **THEN** the Adjust units tab is shown and selected, between Decision and Review


## ADDED Requirements

### Requirement: Behavior overrides
A `gate:define` request for a change with behavior items SHALL carry `overridableBehavior`: each item's capability and effective outcome. The human MAY mark any of them `changed`: on the dialog's Behavior tab, with forge `set behavior` comments before the outcome command, or in an optional `select` fallback step after "request changes". Overrides SHALL be sent only with `changes_requested`. With any other outcome they SHALL be discarded and shown so on the Review tab or as a card warning. An unlisted capability SHALL be ignored with a card warning. Approving MUST NOT require an override step.

#### Scenario: Override sent with request changes
- **WHEN** a define gate with behavior item `rate-limit` is shown in the dialog, and the human presses `b`, marks `rate-limit` `changed`, picks request changes, writes the note `cap semantics changed` and submits
- **THEN** the answer is `changes_requested` with notes and the behavior override `{ capability: rate-limit, outcome: changed }`

#### Scenario: Override discarded with approve
- **WHEN** the human marks `rate-limit` `changed` on the Behavior tab, then picks approve and moves to the Review tab
- **THEN** the Review tab shows the override as discarded, and the submitted answer is `approved` with no behavior override

#### Scenario: Forge override then changes
- **WHEN** a writer comments `/livespec set behavior rate-limit changed` and then `/livespec changes update the cap spec` on a pending `gate:define` request
- **THEN** the gate completes `changes_requested` with the behavior override for `rate-limit`

#### Scenario: Forge override then approve
- **WHEN** a writer comments `/livespec set behavior rate-limit changed` and then `/livespec approve`
- **THEN** the gate completes `approved` with no behavior override, and the card warns that the override was ignored

#### Scenario: Behavior key hint
- **WHEN** a define gate with behavior item `rate-limit` is shown in the dialog
- **THEN** the Decision tab shows the `b` key hint, and the dialog has the Decision and Review tabs only until `b` is pressed

#### Scenario: Review shows the override with request changes
- **WHEN** the human marks `rate-limit` `changed`, picks request changes with a note and moves to the Review tab
- **THEN** the Review tab shows the outcome, the note and the override for `rate-limit`

#### Scenario: Select fallback offers the override
- **WHEN** a define gate with behavior item `rate-limit` is shown through the `select` fallback and the human picks request changes
- **THEN** an optional "Mark behavior changed" step lists `rate-limit`; skipping it sends `changes_requested` with no override, and picking `rate-limit` sends the same answer as the dialog

#### Scenario: Override on another gate
- **WHEN** a writer comments `/livespec set behavior rate-limit changed` while the only pending request is `gate:plan`
- **THEN** the comment is ignored with a card warning that behavior can be set only on the define gate

#### Scenario: Unknown capability
- **WHEN** a writer comments `/livespec set behavior cache changed` on a define gate whose behavior items are only `rate-limit`
- **THEN** the comment is ignored with a card warning naming `cache`
