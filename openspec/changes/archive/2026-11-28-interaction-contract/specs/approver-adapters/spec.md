## ADDED Requirements

### Requirement: Interaction contract
Every approver request (gate, amendment, question, stuck report, rule ask) SHALL:
1. ask only an authority decision or what the system does not know; a fact git, the specs, the diff or the ledger can give MUST NOT be asked;
2. state each choice's consequence as its description;
3. carry a briefing with `recommended` and `rationale`, the recommended choice first;
4. be answerable in one pick submitted once; notes and unit overrides MUST NOT be required.

#### Scenario: Approve in one action
- **WHEN** a plan gate with overridable units is shown in the dialog and the human picks the recommended `approve` and submits, without opening the units tab or writing a note
- **THEN** the outcome is `approved` with no overrides

#### Scenario: Every request kind carries a recommendation
- **WHEN** a gate, an amendment, a question, a stuck report and a rule ask are each sent through the forge adapter
- **THEN** each `request` comment holds a briefing with `recommended` and `rationale`, and its "How to answer" table lists the recommended choice first

### Requirement: Contract scope and review
Item 1 of "Interaction contract" SHALL be enforced by review, items 2 to 4 by the request builder and the adapters. Account selection (forge-accounts "Ask once") does not go through the approver and is not covered. The rubric of every reviewer subject, persona subjects included, SHALL name "Interaction contract", so a new or changed request that breaks it is a review finding.

#### Scenario: Reviewer rubric cites the contract
- **WHEN** a `reviewer` packet is built for any subject, `persona:<name>` included
- **THEN** its rubric names approver-adapters "Interaction contract"

### Requirement: Contract enforced at construction
The request builder MUST throw, before anything is written or asked, when a request lacks a briefing, `recommended` or `rationale`, recommends a choice it does not offer, or offers an option without a description; built-in gate actions and `waive` count as described. A tool SHALL refuse the missing field by name first. Stored requests SHALL still be read, shown and answered.

#### Scenario: Request without a recommendation refused at construction
- **WHEN** a test builds a stuck request with options A and B and a briefing without `recommended`
- **THEN** the builder throws naming `recommended`, and no comment is written

#### Scenario: Undescribed option refused at construction
- **WHEN** a test builds a gate request whose named-gate option `accept` has no description
- **THEN** the builder throws naming option `accept`

#### Scenario: Stored request without a briefing still answered
- **WHEN** a pending forge request written before this requirement has no briefing and a writer comments `/livespec approve`
- **THEN** it completes as before

## MODIFIED Requirements

### Requirement: Approver contract
The system SHALL bring every human decision (gate, question, stuck report, amendment and rule `ask`) to a human through an `Approver` with `request(r)`. Answers that arrive later SHALL be collected by polling (see "Polling pending requests"), not through the adapter. A request MUST carry kind (`gate`, `question` or `stuck`), change, phase, summary, links, files, optional options and mode (`blocking` or `async`). Every option SHALL carry a description, and every request SHALL carry a briefing with `recommended` and `rationale`, as request-briefing "Briefing shape" and "Interaction contract" define; a stored request MAY lack them. The summary SHALL hold livespec's payload, which MAY include the subject text an agent gave as data (a question's text, a stuck report), and SHALL never hold the briefing. The kind SHALL follow the subject: `gate:` and `amend:` use `gate`, `question:` uses `question`, and `stuck:` and `decide:` use `stuck`. The answer is `answered`, `pending`, or, for the in-session adapter only, `deferred`:
- `answered` carries outcome (`approved`, `approved_with_notes`, `changes_requested` or `dismissed`), optional choice, notes, by, at, the adapter name, and for plan and amendment gates the optional Difficulty and Tags `overrides` per unit. A question answer SHALL NOT carry a changed requirement; requirement changes are derived from the spec diff (see questions-and-stuck "Spec-diff requirement cascade").
- `pending` carries the request id.
- `deferred` means the human chose "answer later".

An answer MUST come only from the human through the adapter. No tool parameter, model output, briefing or relayed text SHALL be accepted as an answer; a briefing's `recommended` choice MUST NOT be applied unless the human chooses it.

#### Scenario: Tool has no answer parameter
- **WHEN** the parameter schemas of `spec_gate`, `unit_amend`, `spec_question` and `spec_stuck` are inspected
- **THEN** none of them has a parameter for an outcome, a choice or an answer

#### Scenario: Relayed approval refused
- **WHEN** the agent calls `spec_gate plan` and the in-session dialog is cancelled, while the agent's own message says "approved"
- **THEN** the outcome is `dismissed` and the phase does not move

#### Scenario: Amendment request kind
- **WHEN** `unit_amend` sends an amendment request through the forge adapter
- **THEN** the `request` comment has subject `amend:<n>` and kind `gate`

#### Scenario: Decide request kind
- **WHEN** a classification rule asks for U1's `difficulty` and the chain is `[forge]`
- **THEN** the `request` comment has subject `decide:difficulty.U1` and kind `stuck`

#### Scenario: Recommendation is not an answer
- **WHEN** `spec_stuck` runs with options A and B, recommends A, and the in-session dialog is cancelled
- **THEN** the stuck answer has outcome `dismissed` and `choice: ""`

#### Scenario: Question request lists no requirements
- **WHEN** `spec_question` sends Q1 on a change declaring capability `rate-limit` with three requirements
- **THEN** the request and its stored snapshot name no requirement, and the forge request text does not mention `--changes`

### Requirement: In-session adapter
The in-session adapter SHALL be available only when `ctx.hasUI` is true. When the session can draw custom UI (`ctx.mode` is `tui` and `ctx.ui.custom` is available), it SHALL ask the human through one dialog per request drawn with `ctx.ui.custom`, as "In-session dialog" defines. Otherwise, and whenever that dialog resolves `undefined`, it SHALL ask through `ctx.ui.select` and `ctx.ui.input`; the dialog itself never resolves `undefined`, a cancel in it resolves an explicit cancel. Both paths are called by livespec code, and the adapter MUST use only the values they return. For every answer the human submits, both paths SHALL produce the same outcome, choice, notes and answer, and the same overrides for every value the human changed. Where the dialog blocks submitting an empty required text (a request-changes note, a typed answer), the `select` fallback SHALL treat that empty text as `dismissed`. Every yes/no question MUST be an explicit choice between labelled entries, never `ctx.ui.confirm`, because `ctx.ui.confirm` returns the same value for "no" and for a cancelled dialog. A cancelled dialog MUST be treated as `dismissed`. For a question, the human MAY choose "answer later", the only way a human makes a question non-blocking: the question SHALL become non-blocking and the request SHALL move on, as `async`, to the next adapter in the chain; when no adapter is left, the question stays open. It SHALL present the request as request-briefing "In-session presentation" defines. For a question with candidate answers, the human SHALL be offered each candidate, writing an own answer, and answering later; a picked candidate's label SHALL be the answer. Answering a question SHALL take one step: neither path SHALL ask whether the answer changes a requirement, and neither SHALL list requirements. The adapter MUST NOT use `ask_user_question` from `rpiv-ask-user-question` or any other tool or event that another extension can answer. The answer's `by` SHALL be the current forge login, and its adapter `in-session`.

#### Scenario: Approve in the TUI
- **WHEN** `spec_gate define` runs with `hasUI` true and the human selects approve without notes
- **THEN** the outcome is `approved` with adapter `in-session`

#### Scenario: Unavailable without UI
- **WHEN** a tool requests an approval in print mode (`hasUI` false) and the chain is `[in-session, forge]`
- **THEN** the in-session adapter is skipped and the forge adapter receives the request

#### Scenario: Answer later in session
- **WHEN** `spec_question` runs with the chain `[in-session, forge]` and the human chooses "answer later"
- **THEN** the question line shows `(non-blocking)` and a forge request with mode `async` is posted

#### Scenario: Question candidate picked in session
- **WHEN** `spec_question` sends Q2 with candidates `per-user limits` and `per-IP limits` through the `select` path, and the human picks `per-user limits`
- **THEN** Q2 is answered `per-user limits` and no further prompt is shown

#### Scenario: Own answer instead of a candidate
- **WHEN** `spec_question` sends Q2 with candidates in session and the human chooses to write their own answer and types `no limit`
- **THEN** Q2 is answered `no limit`

#### Scenario: Empty required text in the fallback
- **WHEN** a gate is asked through the `select` fallback, and the human picks request changes and leaves the notes empty
- **THEN** the outcome is `dismissed`

#### Scenario: Dialog in the TUI
- **WHEN** `spec_gate define` runs in session with `ctx.mode` `tui` and `ctx.ui.custom` available
- **THEN** the request is shown in one custom dialog and no `ctx.ui.select` or `ctx.ui.input` call is made

#### Scenario: Select chain in RPC mode
- **WHEN** `spec_gate define` runs in session with `hasUI` true and `ctx.mode` `rpc`
- **THEN** the request is asked through `ctx.ui.select` and no custom dialog is opened

#### Scenario: Fallback when the dialog draws nothing
- **WHEN** `spec_stuck` runs in session with `ctx.mode` `tui` and `ctx.ui.custom` resolves `undefined` without any input
- **THEN** the request is asked again through `ctx.ui.select`, and the answer comes from that select

#### Scenario: Same answer on both paths
- **WHEN** the same plan gate request with overridable units is answered once in the dialog and once through the select chain, both times by picking approve, writing the note `ok`, and setting U1's Difficulty to `high`
- **THEN** both answers are `approved_with_notes` with notes `ok` and the override `{ unit: U1, difficulty: high }`

### Requirement: Forge command comments
The forge adapter SHALL read answers only from plain comments whose first line starts with `/livespec `, created after the request, and SHALL accept these commands:
- `approve [notes]`
- `changes <notes>`
- `dismiss [notes]`
- `choose <option-id> [notes]`
- `answer Q<n> <text>`
- `set U<n> difficulty <low|medium|high>`
- `set U<n> tags <a,b,…>`

An `answer` command that contains the removed `--changes` flag MUST NOT answer the question; it SHALL be treated as a comment that cannot be parsed, and its card warning SHALL say that `--changes` was removed and that requirement changes now follow from spec edits.

An answer SHALL count only when `getPermission(author)` returns `write` or `admin`. A comment from an author without that permission, created before the request, that cannot be parsed, or that is ambiguous among pending requests MUST be ignored and reported as a card warning naming the reason. A comment whose author is the plugin's own login SHALL be accepted like any other.

The question class is not a human choice: `/livespec class` and the `--class` flag of `answer` MUST be reported as unparseable and ignored, and own `class` comments written before this rule MUST be ignored.

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
The dialog SHALL show one request on tabs: Decision and Review. With overridable units, the Decision tab SHALL show a key hint, and pressing `u` there, at any width and with no editor open, SHALL add the Adjust units tab between Decision and Review and switch to it; the tab is not shown before. The `select` fallback keeps its "Keep classification" step. Decision SHALL show the entries as request-briefing "In-session presentation" defines; the first nine MAY be picked by number. Every answer SHALL pass the Review tab and SHALL be sent only when the human submits it there. The Review tab SHALL show what will be sent: outcome, option, notes, overrides, and for a question the answer.

#### Scenario: Approve through Review
- **WHEN** a define gate is shown in the dialog, and the human picks approve and submits on the Review tab
- **THEN** the outcome is `approved`

#### Scenario: Review shows the answer before it is sent
- **WHEN** the human picks the `waive` option of a gate with a failing waivable check and moves to the Review tab
- **THEN** the Review tab shows the waive choice and no answer is recorded until the human submits

#### Scenario: No unit tab without overridable units
- **WHEN** a define gate is shown in the dialog
- **THEN** the dialog has the Decision and Review tabs only

#### Scenario: Units tab hidden by default
- **WHEN** a plan gate with units U1 and U2 is shown in the dialog
- **THEN** the dialog has the Decision and Review tabs only, and the Decision tab shows the `u` key hint

#### Scenario: Units tab opened with one key
- **WHEN** a plan gate with units U1 and U2 is shown in the dialog and the human presses `u` on the Decision tab
- **THEN** the Adjust units tab is shown and selected, between Decision and Review

### Requirement: Dialog unit overrides
The Adjust units tab, once opened (see "In-session dialog"), SHALL list each overridable unit with its current Difficulty (`low`, `medium` or `high`) and Tags, as the request carries them, and the human MAY change either. An override SHALL hold only the fields whose value differs from the current one. Overrides SHALL be sent only with `approved`, `approved_with_notes` or an option choice; with request changes the Review tab SHALL show them as discarded and the answer SHALL carry none.

#### Scenario: Unit overrides on their own tab
- **WHEN** a plan gate with units U1 (`low`) and U2 (`medium`) is shown in the dialog, and the human presses `u`, sets U1 to `high`, picks approve and submits
- **THEN** the answer carries the override `{ unit: U1, difficulty: high }` only

#### Scenario: Value set back to the current one
- **WHEN** a plan gate with U1 (`low`) is shown in the dialog, and the human cycles U1 to `high` and back to `low`, picks approve and submits
- **THEN** the answer carries no override

#### Scenario: Overrides discarded with request changes
- **WHEN** a plan gate is shown in the dialog, and the human sets U1 to `high`, picks request changes, writes the note `split U1` and moves to the Review tab
- **THEN** the Review tab shows the override as discarded, and the submitted answer is `changes_requested` with no overrides

### Requirement: Dialog questions
For a question, the Decision tab SHALL offer the candidates, if any, then "write my own answer" with the text typed inside the dialog, and "answer later". The Review tab SHALL show the answer and SHALL NOT ask whether the answer changes a requirement or list any requirement. Submit SHALL be blocked while the typed answer is empty.

#### Scenario: Question answered in the dialog
- **WHEN** Q2 with candidates `per-user limits` and `per-IP limits` is shown in the dialog, the human picks `per-IP limits` and submits on the Review tab
- **THEN** Q2 is answered `per-IP limits`, and the Review tab showed no requirement

#### Scenario: Own answer typed in the dialog
- **WHEN** a question is shown in the dialog, the human picks "write my own answer", types `no limit` and submits on the Review tab
- **THEN** the question is answered `no limit`

#### Scenario: Empty own answer blocked
- **WHEN** a question is shown in the dialog, the human picks "write my own answer", leaves the text empty and tries to submit on the Review tab
- **THEN** the answer is not submitted

#### Scenario: Question without candidates
- **WHEN** a question stored before candidates were required, with no candidates, is shown in the dialog
- **THEN** the Decision tab offers only "write my own answer" and "answer later"
