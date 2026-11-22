## MODIFIED Requirements

### Requirement: Resume at session start
At `session_start` of the main session in an initialized project, the system SHALL map the branch `livespec/<name>` to the open `livespec` change issue whose `Branch:` line equals that branch, falling back to the open change titled `<name>` with a warning, and SHALL show the phase card for it without being asked. On a fix branch the card SHALL be small-fix-lane "Fix card". On any other branch, the card SHALL list the open changes with their phases. The first card of a session MUST point at `specs/product.md` to be read.

#### Scenario: Resume mid-change
- **WHEN** a new session starts on `livespec/per-ip-cap` and the matching issue is in `build` with U3 pending
- **THEN** the card shown at session start names the change, phase `build` and U3 as the next step

#### Scenario: Other branch
- **WHEN** a session starts on `main` with two open changes
- **THEN** the card lists both changes with their phases

#### Scenario: Fix branch
- **WHEN** a session starts on `fix/typo` with two open changes
- **THEN** the card is the fix card for `fix/typo` and does not list the changes

#### Scenario: Product pointer
- **WHEN** the first card of a session is rendered
- **THEN** it asks the agent to read `specs/product.md`

#### Scenario: Forge unavailable
- **WHEN** forge detection fails at session start
- **THEN** the card says the forge is unavailable, the session continues, and no error is thrown into pi

#### Scenario: Child session start
- **WHEN** a child session starts in an initialized project on `livespec/per-ip-cap`
- **THEN** no phase card is shown or added

