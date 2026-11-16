# approver-adapters Specification

## Purpose

Defines how livespec brings gates, questions, stuck reports and decision asks to a human: the `Approver` contract, the in-session and forge adapters, the forge command grammar and permission rule, durable requests and answers with polling, the `interaction.adapter` config and its doctor check.

## Requirements

### Requirement: Approver contract
The system SHALL bring every human decision (gate, question, stuck report, amendment and rule `ask`) to a human through an `Approver` with `request(r)` and `poll(requestId)`. A request MUST carry kind (`gate`, `question` or `stuck`), change, phase, summary, links, files, optional options and mode (`blocking` or `async`). The answer is either `answered` or `pending`:
- `answered` carries outcome (`approved`, `approved_with_notes`, `changes_requested` or `dismissed`), optional choice, notes, by, at, the adapter name, and for questions the optional `changesRequirement` and class.
- `pending` carries the request id.

An answer MUST come only from the human through the adapter. No tool parameter, model output or relayed text SHALL be accepted as an answer.

#### Scenario: Tool has no answer parameter
- **WHEN** the parameter schemas of `spec_gate`, `unit_amend`, `spec_question` and `spec_stuck` are inspected
- **THEN** none of them has a parameter for an outcome, a choice or an answer

#### Scenario: Relayed approval refused
- **WHEN** the agent calls `spec_gate plan` and the in-session dialog is cancelled, while the agent's own message says "approved"
- **THEN** the outcome is `dismissed` and the phase does not move

### Requirement: In-session adapter
The in-session adapter SHALL be available only when `ctx.hasUI` is true. It SHALL ask the human through `ctx.ui.select`, `ctx.ui.confirm` and `ctx.ui.input`, called by livespec code, and it MUST use only the values those calls return. A cancelled dialog MUST be treated as `dismissed`. The adapter MUST NOT use `ask_user_question` from `rpiv-ask-user-question` or any other tool or event that another extension can answer. The answer's `by` SHALL be the current forge login, and its adapter `in-session`.

#### Scenario: Approve in the TUI
- **WHEN** `spec_gate define` runs with `hasUI` true and the human selects approve without notes
- **THEN** the outcome is `approved` with adapter `in-session`

#### Scenario: Unavailable without UI
- **WHEN** a tool requests an approval in print mode (`hasUI` false) and the chain is `[in-session, forge]`
- **THEN** the in-session adapter is skipped and the forge adapter receives the request

### Requirement: Forge adapter request
The forge adapter SHALL be available only when the forge is connected, writable and not blocked by the account. Its `request` SHALL post one own marked comment of kind `request` and return `pending` with the request id. The comment's yaml MUST hold the kind, subject, mode, options, the HEAD commit and the snapshot needed to complete the request. The plain text below the yaml MUST state what is asked and list the accepted commands. At most one request per subject MAY be pending; a second request for the same subject MUST be refused.

#### Scenario: Pending gate request
- **WHEN** `spec_gate plan` runs with the chain `[forge]` and every check passes
- **THEN** one `request` comment for subject `gate:plan` is posted, the tool reports pending, and the phase does not move

#### Scenario: Duplicate request refused
- **WHEN** a `gate:plan` request is pending and `spec_gate plan` runs again
- **THEN** the tool refuses, names the pending request and posts nothing

### Requirement: Forge command comments
The forge adapter SHALL read answers only from plain comments whose first line starts with `/livespec `, created after the request, and SHALL accept these commands:
- `approve [notes]`
- `changes <notes>`
- `dismiss [notes]`
- `choose <option-id> [notes]`
- `answer Q<n> <text> [--changes <capability>/Requirement: <name>] [--class blocking|non-blocking]`
- `class Q<n> blocking|non-blocking`
- `set U<n> difficulty <low|medium|high>`
- `set U<n> tags <a,b,…>`

An answer SHALL count only when `getPermission(author)` returns `write` or `admin`. A comment from an author without that permission, created before the request, that cannot be parsed, or that is ambiguous among pending requests MUST be ignored and reported as a card warning naming the reason. A comment whose author is the plugin's own login SHALL be accepted like any other.

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
- **WHEN** a writer comments `/livespec answer Q2 use per-user limits --changes rate-limit/Requirement: Per-IP cap`
- **THEN** Q2 is answered with `changesRequirement` `rate-limit/Requirement: Per-IP cap`

### Requirement: Polling pending requests
The system SHALL poll pending requests at `session_start` after the forge connects, when `/livespec next` runs, and before every livespec tool runs. A poll MUST skip when the forge is read-only or blocked, and MUST read comments fresh, bypassing the comments cache, only when the snapshot has a pending or applying request. The first valid answer SHALL complete the request, and later commands for that request MUST be ignored. A failed poll MUST be recorded and MUST NOT fail the tool or hook.

#### Scenario: Answer picked up at session start
- **WHEN** a writer approved a pending `gate:define` request while no session ran, and a new session starts on the change branch
- **THEN** the gate is completed and the change is in `plan`

#### Scenario: Poll failure tolerated
- **WHEN** the forge throws a transport error during the poll before `spec_status`
- **THEN** `spec_status` still answers and the session records the poll error

### Requirement: Durable answers
Once an answer has been validated, the plugin SHALL record it as an own `answer` comment holding the request, the answer and the validation verdict. It SHALL do this before applying any effect, for in-session and forge answers alike. A request SHALL be pending while it has no `answer` comment, applying while it has an `answer` comment but no result comment, and completed once a result comment exists. The poll and every livespec tool MUST first finish applying requests, without validating them again.

#### Scenario: Crash while applying
- **WHEN** an in-session approval of an amendment is recorded, the body edit succeeds, and the session ends before the `amendment` comment is written
- **THEN** the next session finishes the amendment without asking again, and the result is not superseded

### Requirement: The plugin writes the result
Whatever adapter answered, the result comment (`gate`, `amendment`, `question`, `stuck` or `decision`) SHALL be written by the plugin as an own marked comment that names the request. The adapter, the answering comment's id and author (forge), `by` and `at` MUST be recorded. A human's comment MUST NOT be read as state by itself, and a marked result comment from another account MUST be ignored.

#### Scenario: Foreign marked gate ignored
- **WHEN** another account posts a valid `<!-- livespec:gate:plan -->` comment with outcome `approved`
- **THEN** the change state has no approved plan gate and the card warns about the foreign marked comment

#### Scenario: Forge answer recorded
- **WHEN** a forge command completes a gate
- **THEN** the `gate` comment records `adapter: forge` and the answering comment id and author

### Requirement: Adapter configuration
`interaction.adapter` SHALL be an ordered list of adapter names (`in-session`, `forge`), read from project config and otherwise user config, defaulting to `[in-session]`. Unknown names MUST be reported as config warnings and dropped. The chain SHALL use the first available adapter in order. When none is available, the tool MUST refuse, write nothing, and name `interaction.adapter`.

#### Scenario: Default chain
- **WHEN** no config sets `interaction.adapter`
- **THEN** the chain is `[in-session]`

#### Scenario: No adapter available
- **WHEN** the chain is `[in-session]` and `hasUI` is false
- **THEN** `spec_gate` refuses, names `interaction.adapter`, and posts nothing

### Requirement: Approver doctor check
Doctor SHALL report the configured chain, where it comes from (project, user or default), and the adapter that would answer in the current session. It MUST report an error when no adapter in the chain is available.

#### Scenario: Doctor names the adapter
- **WHEN** doctor runs in an interactive session with the default chain
- **THEN** it reports `ok` with chain `[in-session]`, source `default`, and in-session as the adapter in use
