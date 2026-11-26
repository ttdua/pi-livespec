## MODIFIED Requirements

### Requirement: In-session adapter
The in-session adapter SHALL be available only when `ctx.hasUI` is true. When the session can draw custom UI (`ctx.mode` is `tui` and `ctx.ui.custom` is available), it SHALL ask the human through one dialog per request drawn with `ctx.ui.custom`, as "In-session dialog" defines. Otherwise, and whenever that dialog resolves `undefined`, it SHALL ask through `ctx.ui.select` and `ctx.ui.input`; the dialog itself never resolves `undefined`, a cancel in it resolves an explicit cancel. Both paths are called by livespec code, and the adapter MUST use only the values they return. For every answer the human submits, both paths SHALL produce the same outcome, choice, notes, answer, changed requirement and class, and the same overrides for every value the human changed. Where the dialog blocks submitting an empty required text (a request-changes note, a typed answer, a typed requirement), the `select` fallback SHALL treat that empty text as `dismissed`. Every yes/no question MUST be an explicit choice between labelled entries, never `ctx.ui.confirm`, because `ctx.ui.confirm` returns the same value for "no" and for a cancelled dialog. A cancelled dialog MUST be treated as `dismissed`. For a question, the human MAY choose "answer later": the question SHALL become non-blocking and the request SHALL move on, as `async`, to the next adapter in the chain; when no adapter is left, the question stays open. It SHALL present the request as request-briefing "In-session presentation" defines. For a question with candidate answers, the human SHALL be offered each candidate, writing an own answer, and answering later; a picked candidate's label SHALL be the answer, and the adapter SHALL then still ask whether the answer changes a requirement. The adapter MUST NOT use `ask_user_question` from `rpiv-ask-user-question` or any other tool or event that another extension can answer. The answer's `by` SHALL be the current forge login, and its adapter `in-session`.

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
- **WHEN** `spec_question` sends Q2 with candidates `per-user limits` and `per-IP limits` in session, the human picks `per-user limits` and answers that no requirement changes
- **THEN** Q2 is answered `per-user limits`

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

## ADDED Requirements

### Requirement: In-session dialog
The dialog SHALL show one request on tabs: Decision, Adjust units (only with overridable units), Review. Decision SHALL show the entries as request-briefing "In-session presentation" defines; the first nine MAY be picked by number. Every answer SHALL pass the Review tab and SHALL be sent only when the human submits it there. The Review tab SHALL show what will be sent: outcome, option, notes, overrides, and for a question the answer and the changed requirement.

#### Scenario: Approve through Review
- **WHEN** a define gate is shown in the dialog, and the human picks approve and submits on the Review tab
- **THEN** the outcome is `approved`

#### Scenario: Review shows the answer before it is sent
- **WHEN** the human picks the `waive` option of a gate with a failing waivable check and moves to the Review tab
- **THEN** the Review tab shows the waive choice and no answer is recorded until the human submits

#### Scenario: No unit tab without overridable units
- **WHEN** a define gate is shown in the dialog
- **THEN** the dialog has the Decision and Review tabs only

### Requirement: Dialog exits without Review
Two picks SHALL end the dialog without the Review tab: "dismiss", which is `dismissed`, and, for a question, "answer later", which is `deferred`. `Esc` SHALL cancel the request, which is `dismissed`; while any text editor in the dialog is open (a note, a typed answer, tags or a typed requirement), `Esc` SHALL only close that editor.

#### Scenario: Answer later skips Review
- **WHEN** a question is shown in the dialog and the human picks "answer later"
- **THEN** the dialog closes and the answer is `deferred`

#### Scenario: Esc cancels the dialog
- **WHEN** a stuck report is shown in the dialog and the human presses `Esc` with no editor open
- **THEN** the answer has outcome `dismissed`

#### Scenario: Esc in the note editor
- **WHEN** the note editor is open in the dialog and the human presses `Esc`
- **THEN** the editor closes, the dialog stays open and nothing is recorded

### Requirement: Dialog notes
On gate, amendment and proposer requests the dialog SHALL let the human write notes inside it. Picking "request changes" SHALL require a non-empty note: with no note, the note editor SHALL open, and the answer MUST NOT be submitted while the note is empty or only whitespace.

#### Scenario: Approve with notes
- **WHEN** a define gate is shown in the dialog, and the human picks approve, writes the note `tighten wording` and submits on the Review tab
- **THEN** the outcome is `approved_with_notes` with notes `tighten wording`

#### Scenario: Request changes needs a note
- **WHEN** the human picks "request changes" in the dialog with no note
- **THEN** the note editor opens, and with the note still empty the answer cannot be submitted

### Requirement: Dialog unit overrides
The Adjust units tab SHALL list each overridable unit with its current Difficulty (`low`, `medium` or `high`) and Tags, as the request carries them, and the human MAY change either. An override SHALL hold only the fields whose value differs from the current one. Overrides SHALL be sent only with `approved`, `approved_with_notes` or an option choice; with request changes the Review tab SHALL show them as discarded and the answer SHALL carry none.

#### Scenario: Unit overrides on their own tab
- **WHEN** a plan gate with units U1 (`low`) and U2 (`medium`) is shown in the dialog, and the human sets U1 to `high`, picks approve and submits
- **THEN** the dialog has an Adjust units tab and the answer carries the override `{ unit: U1, difficulty: high }` only

#### Scenario: Value set back to the current one
- **WHEN** a plan gate with U1 (`low`) is shown in the dialog, and the human cycles U1 to `high` and back to `low`, picks approve and submits
- **THEN** the answer carries no override

#### Scenario: Overrides discarded with request changes
- **WHEN** a plan gate is shown in the dialog, and the human sets U1 to `high`, picks request changes, writes the note `split U1` and moves to the Review tab
- **THEN** the Review tab shows the override as discarded, and the submitted answer is `changes_requested` with no overrides

### Requirement: Dialog questions
For a question, the Decision tab SHALL offer the candidates, if any, then "write my own answer" with the text typed inside the dialog, and "answer later". The Review tab SHALL ask whether the answer changes a requirement, offering `no`, each declared requirement, and a typed one. Submit SHALL be blocked while the typed answer or the typed requirement is empty.

#### Scenario: Question answered in the dialog
- **WHEN** Q2 with candidates `per-user limits` and `per-IP limits` is shown in the dialog, the human picks `per-IP limits` and, on the Review tab, picks the declared requirement `rate-limiting/Requirement: Limits`
- **THEN** Q2 is answered `per-IP limits` with `changesRequirement` `rate-limiting/Requirement: Limits`

#### Scenario: Own answer typed in the dialog
- **WHEN** a question is shown in the dialog, the human picks "write my own answer", types `no limit`, answers `no` on the Review tab and submits
- **THEN** the question is answered `no limit`

#### Scenario: Question without candidates
- **WHEN** a question with no candidates is shown in the dialog
- **THEN** the Decision tab offers only "write my own answer" and "answer later"

### Requirement: Dialog choices
Stuck reports and rule asks SHALL show their options and the Review tab, with no notes and no unit tab, as the `select` path does today. A note on such an answer stays available through the forge command `/livespec choose <id> [notes]`.

#### Scenario: Stuck choice in the dialog
- **WHEN** a stuck report with options A and B is shown in the dialog, and the human picks B and submits
- **THEN** the answer is `approved` with choice `B` and the dialog had no unit tab

### Requirement: Dialog layout and text safety
The dialog MUST keep the entries visible: when the facts and the briefing do not fit, they SHALL scroll above the entries. Below 60 columns it SHALL hide option descriptions and key hints, and below 40 columns it SHALL show only a line asking to widen the terminal or press `Esc`. Agent text MUST be neutralised and stripped of terminal control characters other than newline and tab before it is drawn, and a status SHALL never be shown by colour alone.

#### Scenario: Narrow terminal
- **WHEN** the dialog is drawn 35 columns wide
- **THEN** it shows only a line asking to widen the terminal or press `Esc`

#### Scenario: Medium width hides descriptions and hints
- **WHEN** the dialog of a define gate is drawn 50 columns wide
- **THEN** each entry shows its label without its description, and no key-hint line is drawn

#### Scenario: Status without colour
- **WHEN** a gate with a failing waivable check is drawn with a theme that applies no colour
- **THEN** the line of that check still starts with `!`

#### Scenario: Long briefing scrolls
- **WHEN** a gate with a 40-line payload is drawn 20 rows high
- **THEN** every entry is visible and the payload is scrolled above them

#### Scenario: Terminal control characters in agent text
- **WHEN** a gate briefing summary contains `\x1b[2J` and an OSC sequence
- **THEN** the drawn dialog contains neither escape sequence
