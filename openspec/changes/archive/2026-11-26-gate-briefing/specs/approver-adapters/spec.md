## MODIFIED Requirements

### Requirement: Approver contract
The system SHALL bring every human decision (gate, question, stuck report, amendment and rule `ask`) to a human through an `Approver` with `request(r)`. Answers that arrive later SHALL be collected by polling (see "Polling pending requests"), not through the adapter. A request MUST carry kind (`gate`, `question` or `stuck`), change, phase, summary, links, files, optional options and mode (`blocking` or `async`). An option MAY carry a description, and a request MAY carry a briefing, as request-briefing "Briefing shape" defines. The summary SHALL hold livespec's payload, which MAY include the subject text an agent gave as data (a question's text, a stuck report), and SHALL never hold the briefing. The kind SHALL follow the subject: `gate:` and `amend:` use `gate`, `question:` uses `question`, and `stuck:` and `decide:` use `stuck`. The answer is `answered`, `pending`, or, for the in-session adapter only, `deferred`:
- `answered` carries outcome (`approved`, `approved_with_notes`, `changes_requested` or `dismissed`), optional choice, notes, by, at, the adapter name, for questions the optional `changesRequirement` and class, and for plan and amendment gates the optional Difficulty and Tags `overrides` per unit.
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

### Requirement: In-session adapter
The in-session adapter SHALL be available only when `ctx.hasUI` is true. It SHALL ask the human through `ctx.ui.select` and `ctx.ui.input`, called by livespec code, and it MUST use only the values those calls return. Every yes/no question MUST be a `select` over explicit labels, because `ctx.ui.confirm` returns the same value for "no" and for a cancelled dialog. A cancelled dialog MUST be treated as `dismissed`. For a question, the human MAY choose "answer later": the question SHALL become non-blocking and the request SHALL move on, as `async`, to the next adapter in the chain; when no adapter is left, the question stays open. It SHALL present the request as request-briefing "In-session presentation" defines. For a question with candidate answers, the menu SHALL offer each candidate, writing an own answer, and answering later; a picked candidate's label SHALL be the answer, and the adapter SHALL then still ask whether the answer changes a requirement. The adapter MUST NOT use `ask_user_question` from `rpiv-ask-user-question` or any other tool or event that another extension can answer. The answer's `by` SHALL be the current forge login, and its adapter `in-session`.

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

### Requirement: Forge adapter request
The forge adapter SHALL be available only when the forge is connected, writable and not blocked by the account. Its `request` SHALL post one own marked comment of kind `request` and return `pending` with the request id. The comment's yaml MUST hold the kind, subject, mode, options with their descriptions, the briefing when there is one, the HEAD commit and the snapshot needed to complete the request. The plain text below the yaml MUST follow request-briefing "Forge request text". A question's candidates SHALL be answered only with `/livespec answer`; `/livespec choose` MUST NOT answer a question. At most one request per subject MAY be pending; a second request for the same subject MUST be refused.

#### Scenario: Pending gate request
- **WHEN** `spec_gate plan` runs with the chain `[forge]` and every check passes
- **THEN** one `request` comment for subject `gate:plan` is posted, the tool reports pending, and the phase does not move

#### Scenario: Duplicate request refused
- **WHEN** a `gate:plan` request is pending and `spec_gate plan` runs again
- **THEN** the tool refuses, names the pending request and posts nothing
