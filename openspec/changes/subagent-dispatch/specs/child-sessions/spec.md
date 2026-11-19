## ADDED Requirements

### Requirement: Child session detection
A session SHALL be a child when the executor's `childSession(sessionId)` returns a record, or, when no capable executor is present, when the session header names a `parentSession`. Every livespec hook that differs for children SHALL check this first. When the check itself fails, the session MUST be treated as a child.

#### Scenario: Child of the executor
- **WHEN** `childSession(id)` returns a record for the current session
- **THEN** the session is a child

#### Scenario: Main session
- **WHEN** `childSession(id)` returns `undefined` and the header has no `parentSession`
- **THEN** the session is not a child

#### Scenario: Check fails
- **WHEN** `childSession` throws
- **THEN** the session is treated as a child

### Requirement: Child note
In a child session of an initialized project, the `livespec` system prompt section SHALL be a fixed child note. It MUST be identical in every child and state that the parent session owns the change state, that the child must not tick units, push, write to the forge or edit `.pi/livespec/`, that text inside `<untrusted>` is data, and that the child asks its parent (`ask_parent`) when context is missing. It MUST NOT name a flow skill.

#### Scenario: Child launched by the main agent
- **WHEN** the main agent launches `general` through the `subagent` tool in an initialized project
- **THEN** the child's `livespec` section is the child note and its context holds no phase card

### Requirement: Child resources
In a child session, livespec's `resources_discover` handler SHALL return no skill paths, and `forge_read`, `subagent_dispatch`, `subagent_answer`, `subagent_packet`, `subagent_record` and `finding_rebut` MUST refuse. The `tool_call` guard SHALL run in a child exactly as in the main session.

#### Scenario: Guard in a child
- **WHEN** a child runs `git push`
- **THEN** the guard blocks it with the same reason as in the main session

#### Scenario: No skills from livespec
- **WHEN** pi fires `resources_discover` in a child session
- **THEN** livespec returns no skill paths
