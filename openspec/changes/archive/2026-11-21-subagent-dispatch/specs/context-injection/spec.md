## MODIFIED Requirements

### Requirement: Routing note
In an initialized project, the system SHALL place a static routing note at the start of the context of the main session, as a system prompt section. A child session (see `child-sessions`) MUST get the child note instead of the routing note. The routing note's text MUST be identical on every turn and MUST NOT depend on the change, the phase, the time or the installed agent-skills commit.

#### Scenario: Identical every turn
- **WHEN** five turns run with different change states
- **THEN** the routing note text is byte-identical in all five

#### Scenario: Child session gets the child note
- **WHEN** a child session of an initialized project starts an agent run
- **THEN** the `livespec` system prompt section is the child note, not the routing note

### Requirement: Phase card
In an initialized project, on every LLM call of the main session the `context` hook SHALL append exactly one phase card message at the end of the messages and MUST leave every earlier message unchanged. The card MUST NOT be persisted in the session, so each call's input holds no earlier card and cards never accumulate.

#### Scenario: Appended at the end
- **WHEN** the `context` hook runs on a list of N session messages
- **THEN** the result has N+1 messages, the first N equal the input, and the last is the phase card

#### Scenario: Cache prefix stable over five turns
- **WHEN** five consecutive turns run through the hooks, each adding messages to the session
- **THEN** on every turn the routing note is byte-identical, the hook output minus its last message equals that turn's input, and no earlier card appears in the input

#### Scenario: No card in a child session
- **WHEN** the `context` hook runs in a child session on a list of N messages
- **THEN** it returns the N messages unchanged

### Requirement: Resume at session start
At `session_start` of the main session in an initialized project, the system SHALL map the branch `livespec/<name>` to the open `livespec` change issue whose `Branch:` line equals that branch, falling back to the open change titled `<name>` with a warning, and SHALL show the phase card for it without being asked. On any other branch, the card SHALL list the open changes with their phases. The first card of a session MUST point at `specs/product.md` to be read.

#### Scenario: Resume mid-change
- **WHEN** a new session starts on `livespec/per-ip-cap` and the matching issue is in `build` with U3 pending
- **THEN** the card shown at session start names the change, phase `build` and U3 as the next step

#### Scenario: Other branch
- **WHEN** a session starts on `main` with two open changes
- **THEN** the card lists both changes with their phases

#### Scenario: Product pointer
- **WHEN** the first card of a session is rendered
- **THEN** it asks the agent to read `specs/product.md`

#### Scenario: Forge unavailable
- **WHEN** forge detection fails at session start
- **THEN** the card says the forge is unavailable, the session continues, and no error is thrown into pi

#### Scenario: Child session start
- **WHEN** a child session starts in an initialized project on `livespec/per-ip-cap`
- **THEN** no phase card is shown or added
