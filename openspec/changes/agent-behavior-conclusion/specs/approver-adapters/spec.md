## MODIFIED Requirements

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
A `gate:define` request for a change with behavior items SHALL carry `overridableBehavior`: each item's capability and effective outcome. In session, the human MAY mark any of them `changed`: on the dialog's Behavior tab, or in an optional `select` fallback step after "request changes". Overrides SHALL be sent only with `changes_requested`; with any other outcome they SHALL be discarded and shown so on the Review tab. The forge adapter SHALL offer no behavior override, and its command grammar SHALL stay unchanged. Approving MUST NOT require an override step.

#### Scenario: Override sent with request changes
- **WHEN** a define gate with behavior item `rate-limit` is shown in the dialog, and the human presses `b`, marks `rate-limit` `changed`, picks request changes, writes the note `cap semantics changed` and submits
- **THEN** the answer is `changes_requested` with notes and the behavior override `{ capability: rate-limit, outcome: changed }`

#### Scenario: Override discarded with approve
- **WHEN** the human marks `rate-limit` `changed` on the Behavior tab, then picks approve and moves to the Review tab
- **THEN** the Review tab shows the override as discarded, and the submitted answer is `approved` with no behavior override

#### Scenario: Behavior key hint
- **WHEN** a define gate with behavior item `rate-limit` is shown in the dialog
- **THEN** the Decision tab shows the `b` key hint, and the dialog has the Decision and Review tabs only until `b` is pressed

#### Scenario: Review shows the override with request changes
- **WHEN** the human marks `rate-limit` `changed`, picks request changes with a note and moves to the Review tab
- **THEN** the Review tab shows the outcome, the note and the override for `rate-limit`

#### Scenario: Select fallback offers the override
- **WHEN** a define gate with behavior item `rate-limit` is shown through the `select` fallback and the human picks request changes
- **THEN** an optional "Mark behavior changed" step lists `rate-limit`; skipping it sends `changes_requested` with no override, and picking `rate-limit` sends the same answer as the dialog

#### Scenario: No override on the forge
- **WHEN** a writer comments `/livespec set behavior rate-limit changed` on a pending `gate:define` request
- **THEN** the comment is ignored as unparseable with a card warning, and the request stays pending
