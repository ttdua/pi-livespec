## MODIFIED Requirements

### Requirement: Approver contract
The system SHALL bring every human decision (gate, question, stuck report, amendment and rule `ask`) to a human through an `Approver` with `request(r)`. Answers that arrive later SHALL be collected by polling (see "Polling pending requests"), not through the adapter. A request MUST carry kind (`gate`, `question` or `stuck`), change, phase, summary, links, files, optional options and mode (`blocking` or `async`). The kind SHALL follow the subject: `gate:` and `amend:` use `gate`, `question:` uses `question`, and `stuck:` and `decide:` use `stuck`. The answer is `answered`, `pending`, or, for the in-session adapter only, `deferred`:
- `answered` carries outcome (`approved`, `approved_with_notes`, `changes_requested` or `dismissed`), optional choice, notes, by, at, the adapter name, for questions the optional `changesRequirement` and class, and for plan and amendment gates the optional Difficulty and Tags `overrides` per unit.
- `pending` carries the request id.
- `deferred` means the human chose "answer later".

An answer MUST come only from the human through the adapter. No tool parameter, model output or relayed text SHALL be accepted as an answer.

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

### Requirement: In-session adapter
The in-session adapter SHALL be available only when `ctx.hasUI` is true. It SHALL ask the human through `ctx.ui.select` and `ctx.ui.input`, called by livespec code, and it MUST use only the values those calls return. Every yes/no question MUST be a `select` over explicit labels, because `ctx.ui.confirm` returns the same value for "no" and for a cancelled dialog. A cancelled dialog MUST be treated as `dismissed`. For a question, the human MAY choose "answer later": the question SHALL become non-blocking and the request SHALL move on, as `async`, to the next adapter in the chain; when no adapter is left, the question stays open. The adapter MUST NOT use `ask_user_question` from `rpiv-ask-user-question` or any other tool or event that another extension can answer. The answer's `by` SHALL be the current forge login, and its adapter `in-session`.

#### Scenario: Approve in the TUI
- **WHEN** `spec_gate define` runs with `hasUI` true and the human selects approve without notes
- **THEN** the outcome is `approved` with adapter `in-session`

#### Scenario: Unavailable without UI
- **WHEN** a tool requests an approval in print mode (`hasUI` false) and the chain is `[in-session, forge]`
- **THEN** the in-session adapter is skipped and the forge adapter receives the request

#### Scenario: Answer later in session
- **WHEN** `spec_question` runs with the chain `[in-session, forge]` and the human chooses "answer later"
- **THEN** the question line shows `(non-blocking)` and a forge request with mode `async` is posted

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

A `class` command SHALL take effect once. When a poll handles it, the plugin SHALL rewrite the question's class if it differs, then record the command with an own marked comment of kind `class`, id the command comment's id and data `{ question, class }`; it SHALL record the command the same way when the class already matches. Later polls, in any session, MUST NOT apply a recorded command again. When the body write fails or conflicts, nothing is recorded and the next poll retries. When the body write succeeds but recording fails, the next poll MAY apply the command once more before recording it.

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

#### Scenario: Class command applied once
- **WHEN** a writer's `/livespec class Q2 non-blocking` was applied by a poll, someone then edits Q2's line back to `(blocking)` on the web, and Q2's request is still pending at the next poll
- **THEN** Q2 stays `(blocking)` after the next poll

#### Scenario: Class command recorded across sessions
- **WHEN** a poll in one session applied and recorded `/livespec class Q2 non-blocking`, someone edits Q2's line to `(blocking)`, and a new session polls while Q2's request is pending
- **THEN** Q2 stays `(blocking)`

#### Scenario: Class command already matching
- **WHEN** Q2 is `(non-blocking)`, a writer comments `/livespec class Q2 non-blocking`, a poll runs, and someone then edits Q2's line to `(blocking)` while its request is pending
- **THEN** a `class` comment records the command and Q2 stays `(blocking)` after the next poll

#### Scenario: Class rewrite conflict retried
- **WHEN** a poll handles `/livespec class Q2 non-blocking` and the body write reports a version conflict
- **THEN** no `class` comment is written, and the next poll rewrites Q2 to `(non-blocking)` and records the command

### Requirement: Adapter configuration
`interaction.adapter` SHALL be an ordered list of adapter names (`in-session`, `forge`), read from project config and otherwise user config, defaulting to `[in-session]`. Unknown names MUST be reported as config warnings and dropped. An empty list, whether written empty or left empty after dropping unknown names, SHALL count as unset, so the chain falls back to the next layer. The chain SHALL use the first available adapter in order. When none is available, the tool MUST refuse, write nothing, and name `interaction.adapter`.

#### Scenario: Default chain
- **WHEN** no config sets `interaction.adapter`
- **THEN** the chain is `[in-session]`

#### Scenario: No adapter available
- **WHEN** the chain is `[in-session]` and `hasUI` is false
- **THEN** `spec_gate` refuses, names `interaction.adapter`, and posts nothing

#### Scenario: Project list with only unknown names
- **WHEN** project config sets `interaction.adapter: [slack]` and user config sets `[forge]`
- **THEN** a config warning names `slack` and the chain is `[forge]` with source `user`

#### Scenario: Empty project list
- **WHEN** project config sets `interaction.adapter: []` and user config sets `[forge]`
- **THEN** the chain is `[forge]` with source `user`

#### Scenario: Every list empty
- **WHEN** project and user config both set `interaction.adapter: []`
- **THEN** the chain is `[in-session]` with source `default`
